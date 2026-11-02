"""Trains one Tier 1 size on the train seeds, then evaluates it on the held-out seeds (evaluate.py).

    python fit.py <shards> <out_dir> --config 5m [--steps 20000]
Writes <out_dir>/<config>.pt (weights, config, action names, temperature) and <config>.json (losses and metrics)."""
import argparse, json, math, time
from pathlib import Path

import numpy as np
import torch
from torch.utils.data import DataLoader, WeightedRandomSampler

from data import Rows, vocab
from evaluate import evaluate
from model import Tier1, losses

WEIGHTS = {'outcome': 1, 'duration': 0.2, 'disp': 1, 'health': 1, 'disp1': 0.5, 'disp3': 0.5, 'veto1': 0.5, 'damage3': 0.5}


def batches(loader):
    while True:
        yield from loader


def main(a):
    torch.manual_seed(0)
    dev = 'cuda' if torch.cuda.is_available() else 'cpu'
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    actions = vocab(a.shards)
    ds = Rows(a.shards, 'train', actions, augment=True)
    # Action starts are ~1 row in 4; weight them to half of each batch, where the outcome heads learn.
    start = ds.is_start()
    w = np.where(start, 0.5 / max(1, start.sum()), 0.5 / max(1, (~start).sum()))
    loader = DataLoader(ds, a.batch, sampler=WeightedRandomSampler(w, len(ds)), num_workers=a.workers,
                        pin_memory=dev == 'cuda', drop_last=len(ds) > a.batch, persistent_workers=a.workers > 0)
    model = Tier1(a.config, len(actions)).to(dev)
    n_params = sum(p.numel() for p in model.parameters())
    print(f'{a.config}: {n_params / 1e6:.2f}M parameters, {len(ds)} rows ({start.sum()} action starts), {dev}', flush=True)
    opt = torch.optim.AdamW(model.parameters(), lr=a.lr, weight_decay=0.05)
    warm = min(1000, a.steps // 10 + 1)
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1, (s + 1) / warm) * 0.5 * (1 + math.cos(math.pi * min(1, s / a.steps))))
    log, t0 = [], time.time()
    for step, b in zip(range(a.steps), batches(loader)):
        model.train()
        b = {k: v.to(dev, non_blocking=True) for k, v in b.items()}
        with torch.autocast(dev, torch.bfloat16, enabled=dev == 'cuda'):
            out_ = model(b)
        parts = losses({k: v.float() for k, v in out_.items()}, b)
        loss = sum(WEIGHTS[k] * v for k, v in parts.items())
        opt.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step()
        sched.step()
        if step % a.log_every == 0 or step == a.steps - 1:
            row = {'step': step, 'loss': float(loss), **{k: float(v) for k, v in parts.items()}, 's': round(time.time() - t0)}
            log.append(row)
            print(json.dumps(row), flush=True)

    metrics = evaluate(model, a.shards, actions, dev, workers=a.workers)
    ck = {'model': model.state_dict(), 'config': a.config, 'actions': actions, 'temperature': metrics['temperature']}
    torch.save(ck, out / f'{a.config}.pt')
    (out / f'{a.config}.json').write_text(json.dumps({'config': a.config, 'parameters': n_params, 'steps': a.steps,
                                                      'batch': a.batch, 'lr': a.lr, 'log': log, 'heldout': metrics}, indent=1))
    print(json.dumps({'config': a.config, 'heldout_all': metrics['per_action'].get('all')}), flush=True)


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('shards')
    p.add_argument('out')
    p.add_argument('--config', default='5m')
    p.add_argument('--steps', type=int, default=20000)
    p.add_argument('--batch', type=int, default=256)
    p.add_argument('--lr', type=float, default=3e-4)
    p.add_argument('--workers', type=int, default=7)
    p.add_argument('--log-every', type=int, default=200)
    main(p.parse_args())
