"""Held-out evaluation (brain/architecture/world-model-training.md → "Evaluation"). The held-out seeds split in two:
temperature is fitted on one half, everything is reported on the other.

    python evaluate.py <checkpoint.pt> <shards> [metrics.json]"""
import json, sys

import numpy as np
import torch
from sklearn.metrics import roc_auc_score
from torch.utils.data import DataLoader

from data import Rows, param_vector, shards
from model import STATE, Tier1, expected_duration


def brier(p, y):
    return float(np.mean((p - y) ** 2)) if len(y) else None


def auroc(p, y):
    return float(roc_auc_score(y, p)) if 0 < y.sum() < len(y) else None


def fit_temperature(logits, y):
    """The T that minimises held-out NLL of softmax(logits / T)."""
    logits, y = torch.as_tensor(logits, dtype=torch.float64), torch.as_tensor(y)
    log_t = torch.zeros(1, dtype=torch.float64, requires_grad=True)
    opt = torch.optim.LBFGS([log_t], lr=0.1, max_iter=200)

    def nll():
        opt.zero_grad()
        loss = torch.nn.functional.cross_entropy(logits / log_t.exp(), y)
        loss.backward()
        return loss
    opt.step(nll)
    return float(log_t.exp())


@torch.no_grad()
def predict(model, ds, device, batch=256, workers=0):
    model.eval()
    out = {k: [] for k in ('logits', 'duration', 'action', 'outcome', 'event', 'duration_s')}
    for b in DataLoader(ds, batch, num_workers=workers):
        b = {k: v.to(device) for k, v in b.items()}
        o = model(b)
        out['logits'].append(o['outcome'].float().cpu())
        out['duration'].append(expected_duration(o['hazard'].float()).cpu())
        for k in ('action', 'outcome', 'event', 'duration_s'):
            out[k].append(b[k].cpu())
    return {k: torch.cat(v).numpy() if v else np.zeros(0) for k, v in out.items()}


def softmax(logits, t=1.0):
    z = logits / t
    z = np.exp(z - z.max(1, keepdims=True))
    return z / z.sum(1, keepdims=True)


def report(pred, actions, t):
    """Per action: n, success rate, success Brier raw and after temperature, AUROC, success rate in the top fifth by
    predicted success, and the duration error on actions that ended by themselves."""
    has = pred['outcome'] >= 0
    p_raw, p_cal = softmax(pred['logits'])[:, 0], softmax(pred['logits'], t)[:, 0]
    y = (pred['outcome'] == 0).astype(float)
    rows = {}
    for a in [None, *np.unique(pred['action'])]:
        m = has & (pred['action'] == a if a is not None else True)
        if not m.any():
            continue
        top = m & (p_cal >= np.quantile(p_cal[m], 0.8))
        ev = (pred['action'] == a if a is not None else True) & pred['event']
        rows['all' if a is None else actions[a]] = {
            'n': int(m.sum()), 'success': float(y[m].mean()), 'brier_raw': brier(p_raw[m], y[m]),
            'brier': brier(p_cal[m], y[m]), 'auroc': auroc(p_cal[m], y[m]), 'top_fifth_success': float(y[top].mean()),
            'duration_mae_s': float(np.abs(pred['duration'][ev] - pred['duration_s'][ev]).mean()) if ev.any() else None,
        }
    return rows


# Which methods a seeker could have drawn: the `fits` in collect/actions/{cross_water,reach_ledge}.ts (any method not
# named fits always). blocks: the kit gave placeable blocks; blocks picked up later are missed.
FITS = {
    'jump_gap': lambda p, blocks: p['dist'] <= 3 and p['width'] <= 3 and p['far'][1] - p['near'][1] <= 1,
    'bridge': lambda p, blocks: blocks and 0 in p['dir'] and p['width'] <= 8,
    'pillar_up': lambda p, blocks: blocks,
}


@torch.no_grad()
def top_ranked(model, ds, device, t=1.0):
    """Whether the top-ranked option succeeds, for actions that pick a method (cross_water, get_down_cliff,
    reach_ledge). The collector draws the method uniformly among those that fit, so over the samples whose method is
    the model's top pick among the fitting ones, each weighted by how many fit (1 / its chance of being drawn), the
    success rate estimates following the model (replay; Li et al. 2011)."""
    model.eval()
    methods = {}
    for i in range(len(ds)):
        a = ds.action_of(i)
        if a and 'method' in a['params']:
            methods.setdefault(a['name'], set()).add(a['params']['method'])
    per = {}
    for i in range(len(ds)):
        a = ds.action_of(i)
        if not (a and 'method' in a['params'] and a['outcome'] >= 0):
            continue
        options = [m for m in sorted(methods[a['name']]) if FITS.get(m, lambda p, b: True)(a['params'], a['blocks'])]
        if a['params']['method'] not in options:  # the fit rules above disagree with the collector's
            continue
        best = options[0]
        if len(options) > 1:
            x = {k: torch.as_tensor(np.asarray(v))[None].to(device) for k, v in ds[i].items()}
            tokens = model.encoder(*(x[k] for k in STATE)).expand(len(options), -1, -1)
            params = torch.as_tensor(np.stack([param_vector({**a['params'], 'method': m}) for m in options])).to(device)
            o = model.query(tokens, x['action'].expand(len(options)), params, x['target'].expand(len(options), -1))
            best = options[int((o['outcome'] / t).softmax(1)[:, 0].argmax())]
        r = per.setdefault(a['name'], {'n': 0, 'success': 0, 'n_top': 0, 'w_top': 0, 'success_top': 0})
        ok = a['outcome'] == 0
        r['n'] += 1
        r['success'] += ok
        if a['params']['method'] == best:
            r['n_top'] += 1
            r['w_top'] += len(options)
            r['success_top'] += len(options) * ok
    return {k: {'n': r['n'], 'random_pick_success': r['success'] / r['n'], 'n_top_pick': r['n_top'],
                'top_pick_success': r['success_top'] / r['w_top'] if r['w_top'] else None} for k, r in per.items()}


def evaluate(model, root, actions, device, workers=0):
    held = [s.seed for s in shards(root, 'heldout')]
    cal, test = (set(held[0::2]), set(held[1::2])) if len(held) > 1 else (set(held), set(held))
    ds_cal = Rows(root, 'heldout', actions, starts_only=True, seeds=cal)
    ds_test = Rows(root, 'heldout', actions, starts_only=True, seeds=test)
    pc = predict(model, ds_cal, device, workers=workers)
    has = pc['outcome'] >= 0
    t = fit_temperature(pc['logits'][has], pc['outcome'][has]) if has.any() else 1.0
    return {'temperature': t, 'calibration_seeds': sorted(cal), 'test_seeds': sorted(test),
            'per_action': report(predict(model, ds_test, device, workers=workers), actions, t),
            'top_ranked': top_ranked(model, ds_test, device, t)}


def load(path, device='cpu'):
    ck = torch.load(path, map_location=device, weights_only=False)
    model = Tier1(ck['config'], len(ck['actions'])).to(device)
    model.load_state_dict(ck['model'])
    return model, ck


if __name__ == '__main__':
    model, ck = load(sys.argv[1])
    m = evaluate(model, sys.argv[2], ck['actions'], 'cpu')
    text = json.dumps(m, indent=1)
    open(sys.argv[3], 'w').write(text) if len(sys.argv) > 3 else print(text)
