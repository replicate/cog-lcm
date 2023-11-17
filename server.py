import os
import time

import asyncio

import aiohttp
from aiohttp import web

import replicate
import logging

logging.getLogger().setLevel("DEBUG")
html = open("index.html").read()


async def index(req: web.Request) -> web.Response:
    return web.Response(body=html, content_type="text/html")


async def js(req: web.Request) -> web.Response:
    return web.Response(
        # body=open("client.js").read(),
        body=open("gpt_client.js").read(),
        content_type="application/javascript",
        headers={"Cache-Control": "No-Cache"},
    )
    return web.Response(body=script, content_type="application/javascript")


async def offer(request: web.Request) -> web.Response:
    print("!!!")
    print("handling offer")
    offer_data = await request.text()
    st = time.time()
    output = await replicate.async_run(
        "technillogue/lcm-webrtc:19d4c41ed444334b95193de6b1bbfe43f7579e09523070272f5e44d892ca8bcc",
        input={"offer": offer_data, "datauri": True, "turn": False},
    )
    print(f"running prediction took {time.time()-st:.3f}")
    st = time.time()
    answer = next(output)
    print(f"got answer from iterator after {time.time()-st:.3f}")
    return web.Response(content_type="application/json", text=answer)


async def next_index(req: web.Request) -> web.Response:
    return web.FileResponse("/app/next/index.html")


app = web.Application()
app.add_routes(
    [
        web.route("*", "/client.js", js),
        web.post("/offer", offer),
        web.route("*", "/", index),
        web.route("*", "/next", next_index),
        # web.static("/", "/app/next"),
    ]
)

if __name__ == "__main__":
    web.run_app(app, port=8080, host="0.0.0.0")
