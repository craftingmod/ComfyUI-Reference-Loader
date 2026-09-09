import pytest

from backend.core.prompt_contract import PromptContractError, parse_prompt_state


def test_v5_prompt_state_is_rejected_without_migration():
  with pytest.raises(PromptContractError, match="must equal 6"):
    parse_prompt_state(
      {
        "version": 5,
        "view": "structured",
        "subjects": [],
        "shots": [],
        "sections": [],
      }
    )
