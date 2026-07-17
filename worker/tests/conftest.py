import sys
from pathlib import Path

# worker/tests has no __init__.py, so pytest's rootless import mode would
# otherwise only add worker/tests (not worker/) to sys.path — but the
# modules under test (dispatcher, parsers.*) live directly under worker/.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
