"""Throwaway: verify the API keys in .env answer 200 on their providers."""

import json
import os
import urllib.error
import urllib.request

from dotenv import load_dotenv

load_dotenv(override=True)


def probe(label, url, headers):
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read(200).decode("utf-8", "replace")
            print(f"{label}: OK {resp.status} {body[:120]}")
    except urllib.error.HTTPError as e:
        print(f"{label}: HTTP {e.code} {e.read(200).decode('utf-8', 'replace')[:200]}")
    except Exception as e:  # noqa: BLE001
        print(f"{label}: ERR {type(e).__name__} {e}")


probe(
    "deepgram",
    "https://api.deepgram.com/v1/projects",
    {"Authorization": f"Token {os.environ.get('DEEPGRAM_API_KEY', '')}"},
)
probe(
    "elevenlabs",
    "https://api.elevenlabs.io/v1/models",
    {"xi-api-key": os.environ.get("ELEVENLABS_API_KEY", "")},
)
probe(
    "anthropic",
    "https://api.anthropic.com/v1/models",
    {
        "x-api-key": os.environ.get("ANTHROPIC_API_KEY", ""),
        "anthropic-version": "2023-06-01",
    },
)
print(json.dumps({k: bool(v) for k, v in os.environ.items() if k.endswith("_API_KEY")}))
