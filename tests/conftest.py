import sys
from pathlib import Path

# Import this repo's custom_components before the test harness can import its own
# testing_config/custom_components under the same name.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import custom_components  # noqa: E402,F401

import pytest  # noqa: E402

pytest_plugins = "pytest_homeassistant_custom_component"


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations):
    yield
