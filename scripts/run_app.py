"""Launch from a source checkout without installing dependencies."""
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from sentinelnode.app import main
main()
