"""ONNX export for Jeeve (onnxruntime on CPU): the state encoder and the action query as two graphs, so one encoding
scores a batch of options. Checks onnxruntime against torch and measures CPU latency.

    python export.py <checkpoint.pt> <out_dir>
Writes encoder.onnx, query.onnx and model.json (action names, temperature, latency).

Inputs are a sample's arrays (data.sample) in the action's frame, so Jeeve does the frame and the parameter hashing
(data.py) and the graphs do the rest. The query's outputs: success-calibrated outcome probabilities, expected
duration (s), end displacement (blocks, action frame) and health change (points)."""
import json, sys, time
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch

from data import ENT, OUTCOMES, P_CAT, P_NUM, SELF, TARGET
from evaluate import load
from model import STATE, expected_duration


class QueryOut(torch.nn.Module):
    def __init__(self, query, temperature):
        super().__init__()
        self.query, self.t = query, temperature

    def forward(self, tokens, action, params, target):
        o = self.query(tokens.expand(action.shape[0], -1, -1), action, params, target)
        return (o['outcome'] / self.t).softmax(1), expected_duration(o['hazard']), o['disp'] * 16, o['health'] * 20


def example_state(b=1):
    z = lambda *s, dt=torch.uint8: torch.zeros(b, *s, dtype=dt)
    return {'near': z(16, 16, 16), 'mid': z(16, 16, 16), 'mid_flags': z(16, 16, 16), 'far_height': z(64, 64, dt=torch.int8),
            'far_top': z(64, 64), 'far_depth': z(64, 64), 'ent_type': z(8, dt=torch.int64),
            'ent': torch.zeros(b, 8, ENT), 'self_vec': torch.zeros(b, SELF), 'held': z(dt=torch.int64)}


def example_options(n):
    return {'action': torch.zeros(n, dtype=torch.int64), 'params': torch.zeros(n, P_NUM + P_CAT), 'target': torch.zeros(n, TARGET)}


def export(model, temperature, out, options=32, reps=50):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    model = model.eval().cpu()
    state = example_state()
    state['near'][:] = torch.randint(0, 63, state['near'].shape, dtype=torch.uint8)
    opts = example_options(options)
    opts['action'] = torch.randint(0, model.n_actions, (options,))
    opts['params'] = torch.randn(options, P_NUM + P_CAT)
    q = QueryOut(model.query, temperature)
    with torch.no_grad():
        tokens = model.encoder(*(state[k] for k in STATE))
        ref = q(tokens, *opts.values())
    torch.onnx.export(model.encoder, tuple(state[k] for k in STATE), out / 'encoder.onnx', input_names=list(STATE),
                      output_names=['tokens'], dynamic_axes={k: {0: 'batch'} for k in [*STATE, 'tokens']}, opset_version=17, dynamo=False)
    torch.onnx.export(q, (tokens, *opts.values()), out / 'query.onnx', input_names=['tokens', *opts],
                      output_names=['outcome', 'duration_s', 'disp', 'dhealth'],
                      dynamic_axes={k: {0: 'n'} for k in [*opts, 'outcome', 'duration_s', 'disp', 'dhealth']}, opset_version=17, dynamo=False)

    so = ort.SessionOptions()
    so.intra_op_num_threads = 1  # Jeeve's container: assume one core is free
    enc = ort.InferenceSession(str(out / 'encoder.onnx'), so, providers=['CPUExecutionProvider'])
    qry = ort.InferenceSession(str(out / 'query.onnx'), so, providers=['CPUExecutionProvider'])
    feed_s = {k: v.numpy() for k, v in state.items()}
    feed_o = {k: v.numpy() for k, v in opts.items()}
    tok = enc.run(None, feed_s)[0]
    got = qry.run(None, {'tokens': tok, **feed_o})
    err = max(float(np.abs(g - r.numpy()).max()) for g, r in zip(got, ref))
    assert err < 1e-3, f'onnxruntime differs from torch by {err}'

    def ms(f):
        f()
        ts = []
        for _ in range(reps):
            t0 = time.perf_counter()
            f()
            ts.append((time.perf_counter() - t0) * 1000)
        return round(float(np.median(ts)), 2)
    return {'outcomes': OUTCOMES, 'temperature': temperature, 'max_abs_diff_vs_torch': err, 'threads': 1, 'options': options,
            'encoder_ms': ms(lambda: enc.run(None, feed_s)), 'query_ms': ms(lambda: qry.run(None, {'tokens': tok, **feed_o}))}


if __name__ == '__main__':
    model, ck = load(sys.argv[1])
    info = {'actions': ck['actions'], **export(model, ck['temperature'], sys.argv[2])}
    (Path(sys.argv[2]) / 'model.json').write_text(json.dumps(info, indent=1))
    print(json.dumps({k: v for k, v in info.items() if k != 'actions'}))
