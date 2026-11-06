"""
token_server.py
----------------
Phase 1 skeleton: a minimal HTTP server that issues LiveKit access tokens
for clients to join a room.

Set these environment variables in a .env file in the project root (replace
with real values):
    LIVEKIT_URL=wss://your-livekit-server-url
    LIVEKIT_API_KEY=your-api-key
    LIVEKIT_API_SECRET=your-api-secret

Run:
    pip install -r requirements.txt
    python token_server.py

Then request a token, e.g.:
    http://localhost:5000/getToken?identity=alice&room=my-room
"""

import os

from dotenv import load_dotenv
from flask import Flask, request, jsonify
from flask_cors import CORS
from livekit import api

# Load LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET from the .env file
# in the project root into the environment.
load_dotenv()

LIVEKIT_API_KEY = os.getenv("LIVEKIT_API_KEY")
LIVEKIT_API_SECRET = os.getenv("LIVEKIT_API_SECRET")
LIVEKIT_URL = os.getenv("LIVEKIT_URL")

app = Flask(__name__)
# Allow all origins to access this API so browser clients hosted on a
# different origin (e.g. a different port/host) can fetch tokens without
# running into CORS "Failed to fetch" errors.
CORS(app, resources={r"/*": {"origins": "*"}})


def create_token(room_name: str, identity: str) -> str:
    """Generate a LiveKit access token that grants join access to a room."""
    token = (
        api.AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
        .with_identity(identity)
        .with_name(identity)
        .with_grants(
            api.VideoGrants(
                room_join=True,
                room=room_name,
            )
        )
    )
    return token.to_jwt()


@app.route("/getToken", methods=["GET"])
def get_token():
    """
    Example: GET /getToken?identity=alice&room=my-room
    Returns: { "token": "<jwt>", "url": "<livekit-server-url>" }
    """
    identity = request.args.get("identity", "guest")
    room = request.args.get("room", "default-room")

    jwt_token = create_token(room_name=room, identity=identity)
    return jsonify({"token": jwt_token, "url": LIVEKIT_URL})


if __name__ == "__main__":
    print("Starting LiveKit token server on http://localhost:5000")
    app.run(host="0.0.0.0", port=5000, debug=True)
