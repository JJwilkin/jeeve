"""Jeeve's live inputs (src/wm.ts) against data.py's: the same state and action must give the same arrays, or the
model's outputs mean nothing live. Random episodes (parity.ts) cover every rotation, mirror-free frame and parameter
shape; every row data.py makes from them (action starts and dense rows) is compared."""
import json, subprocess
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from data import ROTATIONS, episode_rows, sample
from read_episode import read_episode

PARITY = str(Path(__file__).with_name('parity.ts'))
ACTIONS = ['none', 'bridge', 'collect', 'cross_water', 'get_down_cliff', 'navigate', 'reach_ledge', 'sprint_jump',
           'step_down', 'track', 'tunnel', 'walk_raw', 'wander']


def rows_of(path):
    """data.py's rows for one episode, and what Jeeve needs to make each: step, far record, action, elapsed."""
    ep = read_episode(path)
    rows, acts = episode_rows(ep)
    for a in acts:
        a['params'] = json.loads(a['params'])
    far = np.searchsorted(ep['far']['step'], rows['step'], 'right') - 1
    reqs = [{'file': str(path), 'step': int(rows['step'][r]), 'far': int(far[r]),
             'act': {'name': acts[a]['name'], 'params': acts[a]['params']} if (a := int(rows['act'][r])) >= 0 else None,
             'elapsed': float(rows['elapsed'][r]), 'actions': ACTIONS} for r in range(len(rows['act']))]
    return SimpleNamespace(a=rows, actions=acts), reqs


def test_live_inputs_match_training(tmp_path):
    subprocess.run(['node', PARITY, 'episodes', str(tmp_path)], check=True)
    pairs = []
    for f in sorted((tmp_path / 'train' / '1').glob('*.ep.gz')):
        sh, reqs = rows_of(f)
        pairs += [(sh, r, q) for r, q in enumerate(reqs)]
    (tmp_path / 'requests.json').write_text(json.dumps([q for _, _, q in pairs]))
    out = subprocess.run(['node', PARITY, 'inputs', str(tmp_path / 'requests.json')], check=True, capture_output=True, text=True).stdout
    got = [json.loads(line) for line in out.splitlines()]
    assert len(got) == len(pairs) == 4 * (13 + 12)
    vocab = {n: i for i, n in enumerate(ACTIONS)}
    frames = set()
    for (sh, r, q), ts in zip(pairs, got):
        py = sample(sh, r, vocab)
        frames.add(ts['frame'])
        for k in ('near', 'mid', 'mid_flags', 'far_height', 'far_top', 'far_depth', 'ent_type', 'held', 'action'):
            assert np.array_equal(np.asarray(ts[k]).reshape(np.shape(py[k])), py[k]), (k, q)
        for k in ('ent', 'self_vec', 'params', 'target'):
            np.testing.assert_allclose(np.asarray(ts[k], dtype=np.float32).reshape(py[k].shape), py[k], rtol=0, atol=1e-6, err_msg=f'{k} {q}')
    assert frames == set(range(len(ROTATIONS)))  # every rotation was exercised
