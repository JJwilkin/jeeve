"""The no-neural-net baseline: per action, gradient-boosted trees on hand-built features of the action's frame, scored
on the same held-out half and with the same metrics as the Tier 1 model (evaluate.py).

    python baseline.py <shards> [baseline.json]"""
import json, sys

import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier

from data import Rows, shards, vocab
from evaluate import auroc, brier

MIN_TRAIN = 50  # actions with fewer labelled samples get no tree


def features(x, classes):
    """The target, parameters and self state, plus the terrain ahead (+x is the action's direction) in strips."""
    c = {n: classes.index(n) for n in ('air', 'water', 'lava')}
    h = x['far_height'].astype(np.float32)
    h[h == -128] = -48
    top, depth = x['far_top'], x['far_depth']
    strips = []
    for lo, hi in ((33, 41), (41, 49), (49, 64)):  # 1–8, 9–16, 17–31 blocks ahead, 9 wide
        hs, ts = h[lo:hi, 28:37], top[lo:hi, 28:37]
        strips += [hs.mean(), hs.min(), hs.max(), (ts == c['water']).mean(), (ts == c['lava']).mean(), depth[lo:hi, 28:37].max()]
    near = x['near']
    below, feet = near[9:13, 5, 6:11], near[9:13, 6, 6:11]  # 1–4 ahead, the layer under the feet and the feet layer
    blocks = [(below == c['air']).mean(), (below == c['water']).mean(), (below == c['lava']).mean(),
              (feet != c['air']).mean(), (near[:, :6] == c['water']).mean()]
    ents = x['ent_type'] > 0
    dist = np.linalg.norm(x['ent'][:, :3], axis=1)
    return np.concatenate([x['target'], x['params'], x['self_vec'], strips, blocks,
                           [ents.sum(), dist[ents].min() if ents.any() else 3.0]]).astype(np.float32)


def table(ds, classes):
    X, a, y = [], [], []
    for i in range(len(ds)):
        x = ds[i]
        if x['outcome'] < 0:
            continue
        X.append(features(x, classes))
        a.append(int(x['action']))
        y.append(int(x['outcome'] == 0))
    return np.array(X), np.array(a), np.array(y)


def run(root):
    actions = vocab(root)
    classes = shards(root, 'train')[0].classes
    held = [s.seed for s in shards(root, 'heldout')]
    test = set(held[1::2]) if len(held) > 1 else set(held)  # the half evaluate.py reports on
    Xt, at, yt = table(Rows(root, 'train', actions, starts_only=True), classes)
    Xh, ah, yh = table(Rows(root, 'heldout', actions, starts_only=True, seeds=test), classes)
    out, p_all, y_all = {}, [], []
    for a in np.unique(ah):
        mt, mh = at == a, ah == a
        if mt.sum() >= MIN_TRAIN and 0 < yt[mt].sum() < mt.sum():
            p = HistGradientBoostingClassifier(max_depth=4, max_iter=200, random_state=0).fit(Xt[mt], yt[mt]).predict_proba(Xh[mh])[:, 1]
        else:
            p = np.full(mh.sum(), yt[mt].mean() if mt.any() else 0.5)  # too few: the training success rate
        out[actions[a]] = {'n': int(mh.sum()), 'success': float(yh[mh].mean()), 'brier': brier(p, yh[mh]), 'auroc': auroc(p, yh[mh])}
        p_all.append(p)
        y_all.append(yh[mh])
    if p_all:
        p, y = np.concatenate(p_all), np.concatenate(y_all)
        out['all'] = {'n': len(y), 'success': float(y.mean()), 'brier': brier(p, y), 'auroc': auroc(p, y)}
    return out


if __name__ == '__main__':
    text = json.dumps(run(sys.argv[1]), indent=1)
    open(sys.argv[2], 'w').write(text) if len(sys.argv) > 2 else print(text)
