"""Errors that the bridge turns into user-facing events.

Kept separate from aws.py so protocol and mock code don't depend on boto3.
"""


class SsoExpired(Exception):
    def __init__(self, profile: str):
        super().__init__(f"SSO session expired for profile {profile}")
        self.profile = profile


class AgentCoreError(Exception):
    """An error whose message is safe and useful to show the user as-is."""
