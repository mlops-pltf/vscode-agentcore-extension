"""Pick the real AWS backend or the mock, based on the request's settings.

aws.py and mock_runtime.py expose the same functions:
  list_profiles(), list_agents(...), get_agent_card(...),
  get_runtime_user_id(profile), invoke(...)
"""
from agentcore import aws, mock_runtime


def is_mock(settings: dict) -> bool:
    # Only call AWS when the extension explicitly turns mock off
    return settings.get("mock", True) is not False


def backend_for(settings: dict):
    return mock_runtime if is_mock(settings) else aws
