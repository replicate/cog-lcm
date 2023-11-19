import os
import time

import asyncio

import aiohttp
from aiohttp import web

import replicate
import logging

logging.getLogger().setLevel("DEBUG")
html = open("index.html").read()
#servers = '[{"urls": "turn:216.153.60.62:3478", "credential": "fakecred", "username": "fakename"}]'

async def index(req: web.Request) -> web.Response:
    return web.Response(body=html, content_type="text/html")


async def js(req: web.Request) -> web.Response:
    return web.Response(
        body=open("client.js").read(), #.replace("/*SERVERS*/", f"config.iceServers = {servers}"),
        content_type="application/javascript",
        headers={"Cache-Control": "No-Cache"},
    )
    return web.Response(body=script, content_type="application/javascript")


async def offer(request: web.Request) -> web.Response:
    print("!!!")
    print("handling offer")
    data = await request.json()
    offer_data = data["offer"]
    servers = data["servers"]

    st = time.time()
    output = await replicate.async_run(
        "technillogue/lcm-webrtc:d488a31186c9e6e2e92c89a7d21a7d0553e7e637bc8af4ea6747c7a644aa94ae",
        input={"offer": offer_data, "datauri": True, "ice_servers": servers},
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
