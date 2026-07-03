"""Allow `python -m devlog` — used by clients/ios/run.sh to run straight from
a source checkout (PYTHONPATH=src) without installing the package."""
from . import main

main()
