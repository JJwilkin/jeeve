import subprocess
from pathlib import Path

import pytest

from data import build


@pytest.fixture(scope='session')
def shards(tmp_path_factory):
    """Tiny episodes from the TypeScript encoder (fixture.ts), built into shards."""
    root = tmp_path_factory.mktemp('wm')
    subprocess.run(['node', str(Path(__file__).with_name('fixture.ts')), str(root / 'episodes')], check=True)
    build(root / 'episodes', root / 'shards', workers=2)
    return root / 'shards'
