import asyncio
import base64
import io
import json
import os
import time
from typing import Callable, Iterator, List, Optional

import aiortc
import cv2 as cv
import numpy as np
import torch
from aiortc import (
    RTCPeerConnection,
    RTCSessionDescription,
    RTCConfiguration,
    RTCIceServer,
)
from cog import BasePredictor, Input, Path
from diffusers import AutoPipelineForImage2Image, ControlNetModel, DiffusionPipeline
from PIL import Image
from latent_consistency_controlnet import LatentConsistencyModelPipeline_controlnet


class Shutdown(asyncio.Event):
    def __init__(self, timeout: int = 30) -> None:
        self.deadline = time.monotonic() + timeout
        self.timeout = timeout
        self.task = asyncio.create_task(self.exit())
        super().__init__()

    def reset(self) -> None:
        self.deadline = time.monotonic() + timeout

    async def exit(self) -> None:
        while not self.is_set():
            await asyncio.sleep(self.deadline - time.monotonic())
            if self.deadline < time.monotonic():
                print("ping deadline exceeded")
                self.set()

async def accept_offer(
    offer: str,
    handler: Callable[[str | bytes], Iterator[str | bytes]],
    ice_servers: str,
) -> tuple[str, asyncio.Event]:
    print("handling offer")
    params = json.loads(offer)

    offer = RTCSessionDescription(sdp=params["sdp"], type=params["type"])

    print("creating for", offer)
    config = RTCConfiguration([RTCIceServer(**a) for a in json.loads(ice_servers)])
    print("configured for", ice_servers)
    pc = RTCPeerConnection(configuration=config)
    print("made peerconnection", pc)

    done = Shutdown()

    @pc.on("datachannel")
    def on_datachannel(channel: aiortc.rtcdatachannel.RTCDataChannel) -> None:
        print(type(channel))

        @channel.on("message")
        async def on_message(message) -> None:
            print(message)
            if isinstance(message, str) and message.startswith("ping"):
                channel.send(f"pong{message[4:]} {time.time()}")
                done.reset()
            else:
                for result in handler(message):
                    channel.send(result)

    @pc.on("connectionstatechange")
    async def on_connectionstatechange() -> None:
        print("Connection state is %s", pc.connectionState)
        if pc.connectionState == "failed":
            await pc.close()
            done.set()

    # handle offer
    await pc.setRemoteDescription(offer)
    print("set remote description")

    # send answer
    answer = await pc.createAnswer()
    print("created answer", answer)
    await pc.setLocalDescription(answer)
    print("set local description")
    data = json.dumps(
        {"sdp": pc.localDescription.sdp, "type": pc.localDescription.type}
    )
    return data, done


class Predictor(BasePredictor):
    def create_pipeline(
        self,
        pipeline_class,
        safety_checker: bool = True,
        controlnet: Optional[ControlNetModel] = None,
    ):
        kwargs = {
            "cache_dir": "model_cache",
            "local_files_only": True,
        }

        if not safety_checker:
            kwargs["safety_checker"] = None

        if controlnet:
            kwargs["controlnet"] = controlnet
            kwargs["scheduler"] = None

        pipe = pipeline_class.from_pretrained("SimianLuo/LCM_Dreamshaper_v7", **kwargs)
        pipe.to(torch_device="cuda", torch_dtype=torch.float16)
        return pipe

    def setup(self) -> None:
        """Load the model into memory to make running multiple predictions efficient"""

        self.txt2img_pipe = self.create_pipeline(DiffusionPipeline)
        self.txt2img_pipe_unsafe = self.create_pipeline(
            DiffusionPipeline, safety_checker=False
        )

        self.img2img_pipe = self.create_pipeline(AutoPipelineForImage2Image)
        self.img2img_pipe_unsafe = self.create_pipeline(
            AutoPipelineForImage2Image, safety_checker=False
        )

        controlnet_canny = ControlNetModel.from_pretrained(
            "lllyasviel/control_v11p_sd15_canny",
            cache_dir="model_cache",
            local_files_only=True,
            torch_dtype=torch.float16,
        ).to("cuda")

        self.controlnet_pipe = self.create_pipeline(
            LatentConsistencyModelPipeline_controlnet, controlnet=controlnet_canny
        )
        self.controlnet_pipe_unsafe = self.create_pipeline(
            LatentConsistencyModelPipeline_controlnet,
            safety_checker=False,
            controlnet=controlnet_canny,
        )

        # warm the pipes
        self.txt2img_pipe(prompt="warmup")
        self.txt2img_pipe_unsafe(prompt="warmup")
        self.img2img_pipe(prompt="warmup", image=[Image.new("RGB", (768, 768))])
        self.img2img_pipe_unsafe(prompt="warmup", image=[Image.new("RGB", (768, 768))])
        self.controlnet_pipe(
            prompt="warmup",
            image=[Image.new("RGB", (768, 768))],
            control_image=[Image.new("RGB", (768, 768))],
        )
        self.controlnet_pipe_unsafe(
            prompt="warmup",
            image=[Image.new("RGB", (768, 768))],
            control_image=[Image.new("RGB", (768, 768))],
        )
        try:
            self.loop = asyncio.get_running_loop()
        except RuntimeError:
            self.loop = asyncio.new_event_loop()

    def control_image(self, image, canny_low_threshold, canny_high_threshold):
        image = np.array(image)
        canny = cv.Canny(image, canny_low_threshold, canny_high_threshold)
        return Image.fromarray(canny)

    def get_allowed_dimensions(self, base=512, max_dim=1024):
        """
        Function to generate allowed dimensions optimized around a base up to a max
        """
        allowed_dimensions = []
        for i in range(base, max_dim + 1, 64):
            for j in range(base, max_dim + 1, 64):
                allowed_dimensions.append((i, j))
        return allowed_dimensions

    def get_resized_dimensions(self, width, height):
        """
        Function adapted from Lucataco's implementation of SDXL-Controlnet for Replicate
        """
        allowed_dimensions = self.get_allowed_dimensions()
        aspect_ratio = width / height
        print(f"Aspect Ratio: {aspect_ratio:.2f}")
        # Find the closest allowed dimensions that maintain the aspect ratio
        # and are closest to the optimum dimension of 768
        optimum_dimension = 768
        closest_dimensions = min(
            allowed_dimensions,
            key=lambda dim: abs(dim[0] / dim[1] - aspect_ratio)
            + abs(dim[0] - optimum_dimension),
        )
        return closest_dimensions

    def resize_images(self, images, width, height):
        return [
            img.resize((width, height)) if img is not None else None for img in images
        ]

    def open_image(self, image_path):
        return Image.open(str(image_path)) if image_path is not None else None

    def apply_sizing_strategy(
        self, sizing_strategy, width, height, control_image=None, image=None
    ):
        image = self.open_image(image)
        control_image = self.open_image(control_image)

        if sizing_strategy == "input_image":
            print("Resizing based on input image")
            width, height = self.get_dimensions(image)
        elif sizing_strategy == "control_image":
            print("Resizing based on control image")
            width, height = self.get_dimensions(control_image)
        else:
            print("Using given dimensions")

        image, control_image = self.resize_images([image, control_image], width, height)
        return width, height, control_image, image

    def predict(
        self,
        offer: str = Input(description="webRTC offer"),
        datauri: bool = Input(
            description="send as data url rather than bytes", default=False
        ),
        format: str = Input(default="webp"),
        ice_servers: str = Input(
            description="ICE servers to use",
            default='[{"urls":"stun:stun.l.google.com:19302"}]',
        ),
    ) -> Iterator[str]:
        def handler(message: bytes | str) -> Iterator[bytes | str]:
            if message[0] != "{":
                print("received invalid message", message)
                return
            args = json.loads(message)  # works for bytes or str
            start = time.time()
            id = args.pop("id", 0)
            results = self._predict(**args)
            end = time.time()
            for result in results:
                buf = io.BytesIO()
                result.save(buf, format=format)
                if datauri:
                    img = f"data:image/{format};base64,{base64.b64encode(buf.getbuffer()).decode()}"
                    resp = {
                        "gen_time": round(end - start) * 1000),
                        "start": round(start*1000),
                        "end": round(end*1000),
                        "id": id,
                        "image": img,
                    }
                    yield json.dumps(resp)
                else:
                    buf.seek(0)
                    yield buf.read()

        offer, done = self.loop.run_until_complete(
            accept_offer(offer, handler, ice_servers)
        )
        yield offer
        self.loop.run_until_complete(done.wait())
        yield "disconnected"

    # for whatever reason _predict doesn't get un-pydantic'd
    Input = lambda default=None, **_: default

    def _predict(
        self,
        prompt: str = Input(
            description="For multiple prompts, enter each on a new line.",
            default="Self-portrait oil painting, a beautiful cyborg with golden hair, 8k",
        ),
        width: int = Input(
            description="Width of output image. Lower if out of memory",
            default=768,
        ),
        height: int = Input(
            description="Height of output image. Lower if out of memory",
            default=768,
        ),
        sizing_strategy: str = Input(
            description="Decide how to resize images – use width/height, resize based on input image or control image",
            choices=["width/height", "input_image", "control_image"],
            default="width/height",
        ),
        image: Path = Input(
            description="Input image for img2img",
            default=None,
        ),
        prompt_strength: float = Input(
            description="Prompt strength when using img2img. 1.0 corresponds to full destruction of information in image",
            ge=0.0,
            le=1.0,
            default=0.8,
        ),
        num_images: int = Input(
            description="Number of images per prompt",
            ge=1,
            le=50,
            default=1,
        ),
        num_inference_steps: int = Input(
            description="Number of denoising steps. Recommend 1 to 8 steps.",
            ge=1,
            le=50,
            default=8,
        ),
        guidance_scale: float = Input(
            description="Scale for classifier-free guidance", ge=1, le=20, default=8.0
        ),
        lcm_origin_steps: int = Input(
            ge=1,
            default=50,
        ),
        seed: int = Input(
            description="Random seed. Leave blank to randomize the seed", default=None
        ),
        control_image: Path = Input(
            description="Image for controlnet conditioning",
            default=None,
        ),
        controlnet_conditioning_scale: float = Input(
            description="Controlnet conditioning scale",
            ge=0.1,
            le=4.0,
            default=2.0,
        ),
        control_guidance_start: float = Input(
            description="Controlnet start",
            ge=0.0,
            le=1.0,
            default=0.0,
        ),
        control_guidance_end: float = Input(
            description="Controlnet end",
            ge=0.0,
            le=1.0,
            default=1.0,
        ),
        canny_low_threshold: float = Input(
            description="Canny low threshold",
            ge=1,
            le=255,
            default=100,
        ),
        canny_high_threshold: float = Input(
            description="Canny high threshold",
            ge=1,
            le=255,
            default=200,
        ),
        # archive_outputs: bool = Input(
        #     description="Option to archive the output images",
        #     default=False,
        # ),
        disable_safety_checker: bool = Input(
            description="Disable safety checker for generated images. This feature is only available through the API",
            default=False,
        ),
    ) -> List[Path]:
        """Run a single prediction on the model"""

        if seed is None:
            seed = int.from_bytes(os.urandom(2), "big")

        print(f"Using seed: {seed}")

        prompt = prompt.strip().splitlines()
        if len(prompt) == 1:
            print("Found 1 prompt:")
        else:
            print(f"Found {len(prompt)} prompts:")
        for p in prompt:
            print(f"- {p}")

        if len(prompt) * num_images == 1:
            print("Making 1 image")
        else:
            print(f"Making {len(prompt) * num_images} images")

        if image or control_image:
            (
                width,
                height,
                control_image,
                image,
            ) = self.apply_sizing_strategy(
                sizing_strategy, width, height, control_image, image
            )

        kwargs = {}
        canny_image = None

        if image:
            kwargs["image"] = image
            kwargs["strength"] = prompt_strength

        if control_image:
            canny_image = self.control_image(
                control_image, canny_low_threshold, canny_high_threshold
            )
            kwargs["control_guidance_start"]: control_guidance_start
            kwargs["control_guidance_end"]: control_guidance_end
            kwargs["controlnet_conditioning_scale"]: controlnet_conditioning_scale

            # TODO: This is a hack to get controlnet working without an image input
            # The current pipeline doesn't seem to support not having an image, so
            # we pass one in but set strength to 1 to ignore it
            if not image:
                kwargs["image"] = Image.new("RGB", (width, height), (128, 128, 128))
                kwargs["strength"] = 1.0

            kwargs["control_image"] = canny_image

        mode = "controlnet" if control_image else "img2img" if image else "txt2img"
        print(f"{mode} mode")
        pipe = getattr(
            self,
            f"{mode}_pipe" if not disable_safety_checker else f"{mode}_pipe_unsafe",
        )

        common_args = {
            "width": width,
            "height": height,
            "prompt": prompt,
            "guidance_scale": guidance_scale,
            "num_images_per_prompt": num_images,
            "num_inference_steps": num_inference_steps,
            "lcm_origin_steps": lcm_origin_steps,
            "output_type": "pil",
        }
        result = pipe(**common_args, **kwargs, generator=torch.manual_seed(seed)).images
        return result
        # if archive_outputs:
        #     archive_start_time = datetime.datetime.now()
        #     print(f"Archiving images started at {archive_start_time}")

        #     tar_path = "/tmp/output_images.tar"
        #     with tarfile.open(tar_path, "w") as tar:
        #         for i, sample in enumerate(result):
        #             output_path = f"/tmp/out-{i}.png"
        #             sample.save(output_path)
        #             tar.add(output_path, f"out-{i}.png")

        #     return Path(tar_path)

        # # If not archiving, or there is an error in archiving, return the paths of individual images.
        # output_paths = []
        # for i, sample in enumerate(result):
        #     output_path = f"/tmp/out-{i}.jpg"
        #     sample.save(output_path)
        #     output_paths.append(Path(output_path))

        # if canny_image:
        #     canny_image_path = "/tmp/canny-image.jpg"
        #     canny_image.save(canny_image_path)
        #     output_paths.append(Path(canny_image_path))

        # return output_paths
