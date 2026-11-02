"""The world-model dataset (brain/architecture/world-model-training.md).

    python data.py build <episodes> <shards>   # <episodes>/{train,heldout}/<seed>/*.ep.gz → <shards>/{split}/<seed>/

Building turns each seed's episodes (collect/format.ts, read with collect/read_episode.py) into one shard of state rows,
kept in the world frame:
- a row at every action start (the step before it: the state it was chosen from), with the action's labels;
- a row every DENSE_EVERY steps, with the per-step extra targets (where the bot is 1 s and 3 s on, a veto within 1 s,
  damage within 3 s) and the action running then, if any.
`Rows` reads shards and turns a row into model inputs in the action's frame (`sample`)."""
import json, sys, zlib
from multiprocessing import Pool
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'collect'))
from read_episode import read_episode  # noqa: E402

SPLITS = ('train', 'heldout')
STEPS_PER_S = 5
DENSE_EVERY = 10  # 2 s between dense rows; neighbouring steps add little, and 5M full rows wouldn't fit in RAM
H1, H3 = 5, 15  # 1 s and 3 s ahead, in steps
OUTCOMES = ['done', 'stuck', 'vetoed', 'died', 'timeout']
# Recorded outcome → the outcome head's class. Missing: no outcome label (none_found stays out of the success target;
# episode_end and stopped were cut off). `error` (an action's code threw) drops the action.
OUTCOME_OF = {'done': 'done', 'target_dead': 'done', 'stuck': 'stuck', 'target_lost': 'stuck', 'vetoed': 'vetoed',
              'died': 'died', 'timeout': 'timeout'}
CENSORED = {'timeout', 'episode_end', 'stopped'}  # the action was still running when it was cut off
CUT = {'episode_end', 'stopped'}  # cut off from outside: where it ended and its health change aren't its own
POSITION_KEYS = ('place', 'at', 'far', 'floor', 'top', 'near')  # where an action is going, best first (block coords)
NOT_PARAMS = {*POSITION_KEYS, 'dir', 'yaw', 'id'}  # carried as the target, or meaningless (an entity id)
P_NUM, P_CAT = 16, 48  # parameter vector: hashed numeric slots + hashed categorical buckets
TARGET = 8  # rel x y z /16, has position, dir x z, has direction, elapsed /20
SELF = 14  # vel xyz, facing xz, pitch, position in the feet block xyz, on ground, in water, in lava, health, food
ENT = 6  # rel pos /16, vel
NONE = 'none'  # the action id of a dense row between actions


def outcome_key(o):
    return (o or '').split(' ')[0].rstrip(':')


def bucket(s, n):
    """A stable hash of a name into 1..n-1 (0 is 'empty'), the same in Python and in Jeeve (zlib/Node crc32)."""
    return 1 + zlib.crc32(s.encode()) % (n - 1)


# ---------------------------------------------------------------- building shards

def episode_rows(ep):
    """One episode → (row arrays, action records). Rows reference actions by index into this episode's list."""
    h, s, far = ep['header'], ep['steps'], ep['far']
    n = len(s)
    if n == 0:
        return None, []
    actions, starts, kept = [], [], {}
    # the kit gave placeable blocks: any kit item that's a block, except torches (collect/bot.ts KIT)
    solid = {b for c, bs in h.get('class_blocks', {}).items() if c != 'light' for b in bs}
    blocks = any(k.get('item') in solid for k in h.get('kit', []))
    for k, a in enumerate(h.get('actions', [])):
        key = outcome_key(a.get('outcome'))
        if key == 'error' or a.get('end_step') is None:
            continue
        i = min(max(a['start_step'] - 1, 0), n - 1)
        j = min(max(a['end_step'] - 1, i), n - 1)
        kept[k] = len(actions)
        actions.append({
            'name': a['name'], 'params': json.dumps(a.get('params') or {}), 'start_step': a['start_step'],
            'outcome': OUTCOMES.index(OUTCOME_OF[key]) if key in OUTCOME_OF else -1,
            'event': key not in CENSORED, 'duration_s': (a.get('ms') or 0) / 1000,
            'end_disp': (s['pos'][j] - s['pos'][i]).tolist(),
            'dhealth': float(-s['health'][i] if key == 'died' else s['health'][j] - s['health'][i]),
            'full': key not in CUT, 'blocks': blocks,
        })
        starts.append(i)
    # a dense row's running action: recorded index → kept index (−1, between actions, is the last entry)
    rec_to_kept = np.array([kept.get(k, -1) for k in range(len(h.get('actions', [])))] + [-1])
    dense = np.arange(0, n, DENSE_EVERY)
    steps = np.concatenate([np.array(starts, dtype=np.int64), dense])
    act = np.concatenate([np.arange(len(starts)), rec_to_kept[s['action'][dense]]])
    start_of = np.array([a['start_step'] for a in actions] + [0])
    elapsed = np.where(act >= 0, (steps - start_of[act]) / STEPS_PER_S, 0).clip(0)
    elapsed[:len(starts)] = 0

    fi = np.searchsorted(far['step'], steps, 'right') - 1  # the latest far view (1/s)
    has_far = fi >= 0
    fi = fi.clip(0)
    ent_names = h.get('entity_types', [])
    ent_lut = np.array([bucket(str(e), 256) for e in ent_names] + [0], dtype=np.uint8)  # [−1] → 0
    items = h.get('items', [])
    item_lut = np.array([bucket(str(i), 256) for i in items] + [0], dtype=np.uint8)

    pos, hp, veto = s['pos'], s['health'], s['veto']
    m1, m3 = steps + H1 < n, steps + H3 < n
    ahead = lambda k: pos[np.minimum(steps + k, n - 1)] - pos[steps]
    veto1 = np.array([(veto[t + 1:t + 1 + H1] >= 0).any() for t in steps])
    damage3 = np.array([max(0.0, hp[t] - hp[t + 1:t + 1 + H3].min()) if t + 1 < n else 0.0 for t in steps]) / 20

    look, flags = s['look'][steps], s['flags'][steps]
    rows = {
        'near': s['near'][steps], 'mid': s['mid'][steps], 'mid_flags': s['mid_flags'][steps],
        'far_height': np.where(has_far[:, None, None], far['height'][fi], -128).astype(np.int8),
        'far_top': np.where(has_far[:, None, None], far['top'][fi], 255).astype(np.uint8),
        'far_depth': np.where(has_far[:, None, None], far['depth'][fi], 0).astype(np.uint8),
        'ent_type': ent_lut[s['ent_type'][steps]], 'ent_pos': s['ent_pos'][steps], 'ent_vel': s['ent_vel'][steps],
        'pos': pos[steps], 'vel': s['vel'][steps], 'look': look,
        'flags': np.stack([(flags >> b) & 1 for b in range(3)], -1).astype(np.uint8),  # on ground, in water, in lava
        'health': hp[steps], 'food': s['food'][steps], 'held': item_lut[s['held'][steps]],
        'act': act.astype(np.int32), 'elapsed': elapsed.astype(np.float32),
        'is_start': np.arange(len(steps)) < len(starts),
        'disp1': ahead(H1).astype(np.float32), 'disp3': ahead(H3).astype(np.float32), 'm1': m1, 'm3': m3,
        'veto1': veto1, 'damage3': damage3.astype(np.float32),
    }
    return rows, actions


def build_seed(args):
    seed_dir, out = args
    parts, actions, classes = [], [], None
    for f in sorted(seed_dir.glob('*.ep.gz')):
        ep = read_episode(f)
        if classes is None:
            classes = ep['header']['classes']
        assert ep['header']['classes'] == classes, f'{f}: a different block-class table'
        rows, acts = episode_rows(ep)
        if rows is None:
            continue
        rows['act'] = np.where(rows['act'] >= 0, rows['act'] + len(actions), -1).astype(np.int32)
        parts.append(rows)
        actions += acts
    if not parts:
        return None
    out.mkdir(parents=True, exist_ok=True)
    for k in parts[0]:
        np.save(out / f'{k}.npy', np.concatenate([p[k] for p in parts]))
    (out / 'actions.json').write_text(json.dumps(actions))
    (out / 'classes.json').write_text(json.dumps(classes))
    return seed_dir.name, sum(len(p['act']) for p in parts), len(actions)


def build(episodes, shards, workers=8):
    episodes, shards = Path(episodes), Path(shards)
    jobs = [(d, shards / split / d.name) for split in SPLITS for d in sorted((episodes / split).glob('*')) if d.is_dir()]
    with Pool(workers) as pool:
        for r in pool.imap_unordered(build_seed, jobs):
            if r:
                print('seed %s: %d rows, %d actions' % r, flush=True)


# ---------------------------------------------------------------- the frame: xz symmetries of the views
# A symmetry g = (swap, flip_x, flip_z): swap x and z, then mirror x and/or z about the centre of the feet block.
# Every view's x and z start the same distance from the feet, so these are exact on the near and far grids; a mirror
# keeps the feet block in place and fills the one slice it pushes past the edge with 'unloaded'. The mid view's cells
# are 2 blocks wide with the feet at a cell's low edge, so no mirror about the feet block is exact there: its cells
# land one block off (half a cell). ponytail: accepted for a coarse view; exact would need mid cells centred on the feet. Rotations are the four with
# an even number of mirrors (counting swap as one).

ROTATIONS = [(False, False, False), (True, True, False), (False, True, True), (True, False, True)]  # 0°, 90°, 180°, 270°
SYMMETRIES = [(s, x, z) for s in (False, True) for x in (False, True) for z in (False, True)]


def apply_vec(g, v):
    """xz components of a vector (..., 2) under g."""
    swap, fx, fz = g
    v = v[..., ::-1] if swap else v
    return v * np.array([-1 if fx else 1, -1 if fz else 1], dtype=v.dtype)


def apply_vec3(g, v):
    xz = apply_vec(g, v[..., [0, 2]])
    return np.stack([xz[..., 0], v[..., 1], xz[..., 1]], -1)


def mirror_grid(a, axis, fill):
    a = np.roll(np.flip(a, axis), 1, axis)  # index i → 2·c − i about the feet's index c (= half the size)
    idx = [slice(None)] * a.ndim
    idx[axis] = 0
    a[tuple(idx)] = fill
    return a


def apply_grid(g, a, x_axis, z_axis, fill):
    swap, fx, fz = g
    if swap:
        a = np.swapaxes(a, x_axis, z_axis)
    if fx:
        a = mirror_grid(a, x_axis, fill)
    if fz:
        a = mirror_grid(a, z_axis, fill)
    return np.ascontiguousarray(a)


def apply_frac(g, f):
    """The position inside the feet block, x y z in [0, 1), under g (a mirror about the block's centre: 1 − f)."""
    swap, fx, fz = g
    x, y, z = (f[2], f[1], f[0]) if swap else f
    return np.array([1 - x if fx else x, y, 1 - z if fz else z], dtype=np.float32)


def canonical(d):
    """The rotation that turns direction d (x, z) closest to +x."""
    return max(ROTATIONS, key=lambda g: apply_vec(g, np.asarray(d, dtype=np.float64))[0])


def facing(yaw):
    return np.array([-np.sin(yaw), -np.cos(yaw)])  # Mineflayer: yaw 0 faces −z (north), + turns left


# ---------------------------------------------------------------- an action as the model sees it

def target_of(params, start_pos):
    """(target position relative to start_pos or None, unit direction (x, z) or None) from an action's parameters."""
    rel = None
    for k in POSITION_KEYS:
        v = params.get(k)
        if isinstance(v, list) and len(v) == 3 and all(isinstance(c, (int, float)) for c in v):
            rel = np.array(v, dtype=np.float64) + [0.5, 0, 0.5] - start_pos
            break
    d = params.get('dir')
    if isinstance(d, list) and len(d) == 2:
        d = np.array(d, dtype=np.float64)
    elif isinstance(d, (int, float)):
        d = np.array([np.cos(d), np.sin(d)])  # navigate: an angle, x = cos
    elif isinstance(params.get('yaw'), (int, float)):
        d = facing(params['yaw'])
    else:
        d = rel[[0, 2]] if rel is not None else None
    if d is not None:
        norm = np.linalg.norm(d)
        d = d / norm if norm > 1e-6 else None
    return rel, d


def flat_params(params, prefix=''):
    for k, v in params.items():
        if k in NOT_PARAMS:
            continue
        key = prefix + k
        if isinstance(v, dict):
            yield from flat_params(v, key + '.')
        elif isinstance(v, (bool, str)):
            yield key, v
        elif isinstance(v, (int, float)):
            yield key, float(v)


def param_vector(params):
    """Numbers into hashed slots (signed log), strings and booleans into hashed buckets. No per-action schema."""
    v = np.zeros(P_NUM + P_CAT, dtype=np.float32)
    for k, x in flat_params(params):
        if isinstance(x, float):
            v[zlib.crc32(k.encode()) % P_NUM] = np.sign(x) * np.log1p(abs(x))
        else:
            v[P_NUM + zlib.crc32(f'{k}={x}'.encode()) % P_CAT] = 1
    return v


# ---------------------------------------------------------------- reading shards

class Shard:
    def __init__(self, d):
        self.dir = Path(d)
        self.seed = self.dir.name
        self.a = {f.stem: np.load(f, mmap_mode='r') for f in self.dir.glob('*.npy')}
        self.actions = json.loads((self.dir / 'actions.json').read_text())
        for a in self.actions:
            a['params'] = json.loads(a['params'])
        self.classes = json.loads((self.dir / 'classes.json').read_text())
        self.n = len(self.a['act'])


def shards(root, split):
    return [Shard(d) for d in sorted((Path(root) / split).glob('*')) if (d / 'act.npy').exists()]


def vocab(root):
    """Action names across every split, plus 'none'. Saved with each checkpoint."""
    names = {a['name'] for split in SPLITS for sh in shards(root, split) for a in sh.actions}
    return [NONE, *sorted(names)]


class Rows(torch.utils.data.Dataset):
    """Every row of a split, as model inputs and labels. augment: a random mirror (and for undirected actions, a random
    symmetry of all eight)."""

    def __init__(self, root, split, actions, augment=False, starts_only=False, seeds=None):
        self.shards = [s for s in shards(root, split) if seeds is None or s.seed in seeds]
        self.actions = {n: i for i, n in enumerate(actions)}
        self.augment = augment
        self.index = np.concatenate([np.stack([np.full(s.n, k), np.arange(s.n)], 1) for k, s in enumerate(self.shards)]) \
            if self.shards else np.zeros((0, 2), dtype=np.int64)
        if starts_only:
            self.index = self.index[self.is_start()]

    def __len__(self):
        return len(self.index)

    def is_start(self):
        offset = np.cumsum([0] + [s.n for s in self.shards])
        flags = np.concatenate([np.asarray(s.a['is_start']) for s in self.shards]) if self.shards else np.zeros(0, bool)
        return flags[offset[self.index[:, 0]] + self.index[:, 1]]

    def action_of(self, i):
        k, r = self.index[i]
        a = int(self.shards[k].a['act'][r])
        return self.shards[k].actions[a] if a >= 0 else None

    def __getitem__(self, i):
        k, r = self.index[i]
        # torch's generator, seeded per DataLoader worker (a numpy one would repeat across forked workers)
        rng = np.random.default_rng(int(torch.randint(1 << 62, ()))) if self.augment else None
        return sample(self.shards[k], r, self.actions, rng)


def sample(sh, r, actions, rng=None):
    """Row r of a shard → model inputs and labels in the action's frame (see `canonical`)."""
    a = sh.a
    ai = int(a['act'][r])
    act = sh.actions[ai] if ai >= 0 else None
    start = bool(a['is_start'][r])
    pos = np.asarray(a['pos'][r], dtype=np.float64)
    params = act['params'] if act else {}
    rel, d = target_of(params, pos) if act else (None, None)
    directed = d is not None
    g = canonical(d if directed else facing(float(a['look'][r][0])))
    if rng is not None:
        if directed:
            g = g if rng.random() < 0.5 else g[:2] + (not g[2],)  # mirror z: keeps the target's +x
        else:
            g = SYMMETRIES[rng.integers(8)]

    tgt = np.zeros(TARGET, dtype=np.float32)
    if rel is not None:
        tgt[0:3] = apply_vec3(g, rel) / 16
        tgt[3] = 1
    if directed:
        tgt[4:6] = apply_vec(g, d)
        tgt[6] = 1
    tgt[7] = a['elapsed'][r] / 20
    yaw, pitch = float(a['look'][r][0]), float(a['look'][r][1])
    fl = a['flags'][r]
    selfv = np.concatenate([apply_vec3(g, np.asarray(a['vel'][r], dtype=np.float32)), apply_vec(g, facing(yaw)), [pitch],
                            apply_frac(g, pos - np.floor(pos)), fl, [a['health'][r] / 20, a['food'][r] / 20]]).astype(np.float32)
    ent = np.concatenate([apply_vec3(g, np.asarray(a['ent_pos'][r])) / 16, apply_vec3(g, np.asarray(a['ent_vel'][r]))], -1)

    near = lambda x: apply_grid(g, np.asarray(x), 0, 2, 255)
    far = lambda x, fill: apply_grid(g, np.asarray(x), 0, 1, fill)
    out = {
        'near': near(a['near'][r]), 'mid': near(a['mid'][r]), 'mid_flags': apply_grid(g, np.asarray(a['mid_flags'][r]), 0, 2, 0),
        'far_height': far(a['far_height'][r], -128), 'far_top': far(a['far_top'][r], 255), 'far_depth': far(a['far_depth'][r], 0),
        'ent_type': np.asarray(a['ent_type'][r]).astype(np.int64), 'ent': ent.astype(np.float32),
        'self_vec': selfv, 'held': np.int64(a['held'][r]),
        'action': np.int64(actions.get(act['name'], 0) if act else 0),
        'params': param_vector(params), 'target': tgt,
        # labels
        'is_start': start, 'outcome': np.int64(act['outcome'] if start else -1),
        'event': bool(act['event']) if start else False, 'full': bool(act['full']) if start else False, 'duration_s': np.float32(act['duration_s'] if start else 0),
        'end_disp': (apply_vec3(g, np.array(act['end_disp'])) / 16 if start else np.zeros(3)).astype(np.float32),
        'dhealth': np.float32(act['dhealth'] / 20 if start else 0),
        'disp1': (apply_vec3(g, np.asarray(a['disp1'][r])) / 16).astype(np.float32),
        'disp3': (apply_vec3(g, np.asarray(a['disp3'][r])) / 16).astype(np.float32),
        'm1': bool(a['m1'][r]), 'm3': bool(a['m3'][r]), 'veto1': np.float32(a['veto1'][r]), 'damage3': np.float32(a['damage3'][r]),
    }
    return out


if __name__ == '__main__':
    assert sys.argv[1] == 'build', __doc__
    build(sys.argv[2], sys.argv[3], *map(int, sys.argv[4:5]))
