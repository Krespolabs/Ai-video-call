"""Throwaway connectivity check for the LiveKit credentials in .env."""

import asyncio
import os

from dotenv import load_dotenv
from livekit import api

load_dotenv()


async def main():
    lk = api.LiveKitAPI(
        os.environ["LIVEKIT_URL"],
        os.environ["LIVEKIT_API_KEY"],
        os.environ["LIVEKIT_API_SECRET"],
    )
    try:
        rooms = await asyncio.wait_for(lk.room.list_rooms(api.ListRoomsRequest()), 20)
        print("LIVEKIT OK - rooms:", [r.name for r in rooms.rooms])
    finally:
        await lk.aclose()


asyncio.run(main())
