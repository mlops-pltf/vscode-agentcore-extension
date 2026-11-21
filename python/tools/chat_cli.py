"""Chat with an agent from the terminal, through the same bridge the extension uses.

Handy for trying protocols before the panel supports them, and for checking
a real agent's replies (with --raw) without VS Code.

  python python/tools/chat_cli.py                      # HTTP, mock
  python python/tools/chat_cli.py --protocol A2A       # A2A message/send, mock
  python python/tools/chat_cli.py --protocol A2A --stream
  python python/tools/chat_cli.py --real --profile dev --arn arn:aws:bedrock-agentcore:...

Commands while chatting:  /new  start a new session    /quit  exit
Mock keywords: json, slow, error, tool, input, fail, rpcerror
"""
import argparse
import json
import os
import subprocess
import sys
import threading
import uuid

BRIDGE = os.path.join(os.path.dirname(__file__), "..", "bridge.py")
DIM, RED, RESET = "\033[2m", "\033[31m", "\033[0m"


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--protocol", default="HTTP", choices=["HTTP", "A2A"])
    parser.add_argument("--stream", action="store_true", help="A2A: use message/stream")
    parser.add_argument("--real", action="store_true", help="call AWS instead of the mock")
    parser.add_argument("--profile", default="default")
    parser.add_argument("--arn", default="arn:aws:bedrock-agentcore:us-east-1:000000000000:runtime/mock-agent")
    parser.add_argument("--raw", action="store_true", help="also print raw response lines")
    args = parser.parse_args()

    bridge = subprocess.Popen([sys.executable, "-W", "ignore", BRIDGE],
                              stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
    replies = {}  # requestId -> Event set when the reply is finished
    settings = {"mock": not args.real, "a2aStreaming": args.stream, "debugRaw": args.raw}
    session_id = str(uuid.uuid4())

    threading.Thread(target=print_events, args=(bridge, replies), daemon=True).start()
    print(f"{DIM}{args.protocol}{' stream' if args.stream else ''} · "
          f"{'REAL AWS' if args.real else 'mock'} · session {session_id[:8]}{RESET}")

    while True:
        try:
            prompt = input("\nyou> ").strip()
        except (EOFError, KeyboardInterrupt):
            break
        if prompt == "/quit":
            break
        if prompt == "/new":
            send(bridge, {"action": "reset_session", "sessionId": session_id})
            session_id = str(uuid.uuid4())
            print(f"{DIM}new session {session_id[:8]}{RESET}")
            continue
        if not prompt:
            continue

        request_id = str(uuid.uuid4())
        replies[request_id] = threading.Event()
        print("agent> ", end="", flush=True)
        send(bridge, {"action": "invoke_agent", "requestId": request_id, "profile": args.profile,
                      "agentArn": args.arn, "protocol": args.protocol, "prompt": prompt,
                      "sessionId": session_id, "settings": settings})
        try:
            replies[request_id].wait()
        except KeyboardInterrupt:  # Ctrl+C cancels the reply, not the chat
            send(bridge, {"action": "cancel", "requestId": request_id})
            replies[request_id].wait()

    bridge.stdin.close()


def send(bridge, cmd):
    bridge.stdin.write(json.dumps(cmd) + "\n")
    bridge.stdin.flush()


def print_events(bridge, replies):
    for line in bridge.stdout:
        event = json.loads(line)
        kind, request_id = event.get("type"), event.get("requestId")
        if kind == "chunk":
            print(event["text"], end="", flush=True)
        elif kind == "status":
            print(f"\n{DIM}  [{event['text']}]{RESET}", flush=True)
        elif kind == "raw":
            print(f"\n{DIM}  raw: {event['line']}{RESET}", flush=True)
        elif kind == "error":
            print(f"\n{RED}error: {event['message']}{RESET}", flush=True)
        elif kind == "sso_expired":
            print(f"\n{RED}SSO expired: run  aws sso login --profile {event['profile']}{RESET}", flush=True)
        elif kind == "done":
            meta = event.get("meta", {})
            details = " · ".join(f"{k}={v}" for k, v in meta.items() if k != "mock")
            print(f"\n{DIM}  ({details}){RESET}", flush=True)
        if kind in ("done", "error", "sso_expired") and request_id in replies:
            replies[request_id].set()


if __name__ == "__main__":
    main()
