import json
from types import SimpleNamespace

import numpy as np
import pytest
import torch
from torch.utils.data import default_collate

import baseline, export, fit
from data import (OUTCOMES, ROTATIONS, SYMMETRIES, Rows, apply_frac, apply_grid,
                  apply_vec, canonical, facing, param_vector, shards as read_shards, target_of, vocab)
from evaluate import fit_temperature, load
from model import Tier1, expected_duration, losses, survival_loss


def test_shard_labels(shards):
    sh = read_shards(shards, 'train')[0]
    names = [(a['name'], a['outcome'], a['event']) for a in sh.actions]
    # 2 episodes × 6 kept actions (tunnel ended in error); none_found and episode_end have no outcome label
    assert names[:6] == [('navigate', OUTCOMES.index('done'), True), ('sprint_jump', OUTCOMES.index('stuck'), True),
                         ('wander', OUTCOMES.index('timeout'), False), ('bridge', -1, True),
                         ('cross_water', OUTCOMES.index('vetoed'), True), ('walk_raw', -1, False)]
    assert len(sh.actions) == 12 and sh.n == 12 + 2 * 30
    assert [sh.actions[k]['blocks'] for k in (0, 6)] == [False, True]  # a torch isn't a placeable block
    assert [a['full'] for a in sh.actions[:6]] == [True] * 5 + [False]  # walk_raw was cut off by the episode's end
    nav = sh.actions[0]
    assert nav['duration_s'] == pytest.approx(9.8) and nav['end_disp'] == pytest.approx([49 / 5, 0, 0])  # steps 0 → 49
    dense = ~np.asarray(sh.a['is_start'])
    assert np.allclose(sh.a['disp1'][dense][0], [1, 0, 0]) and sh.a['veto1'][dense].sum() == 2  # step 140 sees 145
    assert sh.a['damage3'][dense].max() == pytest.approx(6 / 20)


def test_symmetries_are_exact():
    rng = np.random.default_rng(0)
    near = rng.integers(0, 60, (16, 16, 16)).astype(np.uint8)
    for g in SYMMETRIES:
        # the feet column stays put under every symmetry
        assert (apply_grid(g, near, 0, 2, 255)[8, :, 8] == near[8, :, 8]).all()
    # 90°: block (+3, 0) ahead goes to (0, +3) or (0, −3), and a vector follows the same way
    g = ROTATIONS[1]
    v = apply_vec(g, np.array([3.0, 0.0]))
    a = apply_grid(g, near, 0, 2, 255)
    assert a[8 + int(v[0]), 4, 8 + int(v[1])] == near[11, 4, 8]
    assert apply_frac((False, True, False), np.array([0.25, 0.5, 0.75])) == pytest.approx([0.75, 0.5, 0.75])


def test_canonical_points_the_target_along_x():
    for ang in np.linspace(-np.pi, np.pi, 17):
        d = np.array([np.cos(ang), np.sin(ang)])
        x, z = apply_vec(canonical(d), d)
        assert x >= abs(z) - 1e-9
    assert facing(-np.pi / 2) == pytest.approx([1, 0])  # Mineflayer yaw −π/2 faces +x


def test_targets_and_params():
    rel, d = target_of({'place': [10, 64, 0], 'dir': 0}, np.array([0.5, 64, 0.5]))
    assert rel == pytest.approx([10, 0, 0]) and d == pytest.approx([1, 0])
    assert target_of({}, np.zeros(3)) == (None, None)
    p = param_vector({'method': 'bridge', 'width': 3, 'near': [1, 2, 3], 'mob': {'id': 4, 'name': 'zombie'}})
    assert (p > 0).sum() == 3 and not np.array_equal(p, param_vector({'method': 'navigate', 'width': 3}))


def test_samples_are_in_the_action_frame(shards):
    actions = vocab(shards)
    ds = Rows(shards, 'train', actions)
    i = next(i for i in range(len(ds)) if (a := ds.action_of(i)) and a['name'] == 'cross_water' and ds.is_start()[i])
    x = ds[i]
    assert x['target'][3] == 1 and x['target'][0] > 0 and abs(x['target'][2]) < 1e-6  # far bank straight ahead
    assert x['near'][8 + 4:8 + 7, 5, 8].tolist() == [1, 1, 1]  # the river 4–6 blocks ahead, under the feet's level


def test_model_sizes():
    counts = {c: sum(p.numel() for p in Tier1(c, 24).parameters()) / 1e6 for c in ('2m', '5m', '15m')}
    assert 1.5 < counts['2m'] < 3 and 4 < counts['5m'] < 6.5 and 12 < counts['15m'] < 18, counts


def test_survival_loss_prefers_the_right_time():
    early = torch.full((1, 40), -8.0)
    early[0, 2] = 8  # ends in the 1–1.5 s bin
    late = torch.full((1, 40), -8.0)
    late[0, 30] = 8
    d, ev = torch.tensor([1.2]), torch.tensor([True])
    assert survival_loss(early, d, ev) < survival_loss(late, d, ev)
    assert expected_duration(early) == pytest.approx(1.25, abs=0.01)  # the 1–1.5 s bin's middle
    # a timeout at 20 s only says it survived: nothing to prefer between the two late ones
    assert survival_loss(torch.full((1, 40), -6.0), torch.tensor([20.0]), torch.tensor([False])) < 0.1


def test_forward_losses_and_temperature(shards):
    actions = vocab(shards)
    ds = Rows(shards, 'train', actions, augment=True)
    b = default_collate([ds[i] for i in range(16)])
    model = Tier1('tiny', len(actions))
    parts = losses(model(b), b)
    assert all(torch.isfinite(v) for v in parts.values())
    sum(parts.values()).backward()
    rng = np.random.default_rng(0)
    logits = rng.normal(size=(2000, 5)) * 3
    y = np.array([rng.choice(5, p=np.exp(l / 3) / np.exp(l / 3).sum()) for l in logits])
    assert fit_temperature(logits, y) == pytest.approx(3, rel=0.15)


def test_fit_baseline_export(shards, tmp_path):
    """The whole path on the tiny sample: 3 steps of fit (a code check, not training), held-out metrics, the tree
    baseline, and ONNX parity with torch."""
    fit.main(SimpleNamespace(shards=shards, out=tmp_path, config='tiny', steps=3, batch=8, lr=1e-3, workers=0, log_every=1))
    m = json.loads((tmp_path / 'tiny.json').read_text())['heldout']
    assert m['per_action']['all']['n'] > 0 and 'cross_water' in m['top_ranked']
    assert 'navigate' in baseline.run(shards)
    model, ck = load(tmp_path / 'tiny.pt')
    info = export.export(model, ck['temperature'], tmp_path / 'onnx', reps=2)
    assert info['max_abs_diff_vs_torch'] < 1e-3 and info['encoder_ms'] > 0
