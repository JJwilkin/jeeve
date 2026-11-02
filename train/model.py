"""The Tier 1 outcome model (brain/architecture/world-model-training.md): a state encoder over patch, entity and self
tokens, and an action query that cross-attends to the encoded state, so many options score for one encoding."""
import torch
import torch.nn.functional as F
from torch import nn

from data import ENT, OUTCOMES, P_CAT, P_NUM, SELF, TARGET

BIN_S, BINS = 0.5, 40  # the duration head's hazard bins, out to the 20 s action limit
DENSE = 8  # disp1 xyz, disp3 xyz, veto1 logit, damage3
CONFIGS = {  # ~parameters (tests/test_train.py checks the counts)
    'tiny': dict(d=32, layers=1, heads=2, q_layers=1),
    '2m': dict(d=160, layers=4, heads=5, q_layers=1),
    '5m': dict(d=224, layers=6, heads=7, q_layers=1),
    '15m': dict(d=320, layers=8, heads=8, q_layers=2),
}
E = 16  # block-class embedding width


def layer(d, heads, cls):
    return cls(d, heads, 4 * d, dropout=0.0, batch_first=True, norm_first=True)


class Encoder(nn.Module):
    """Views + entities + self → 64 near + 64 mid + 64 far + 8 entity + 1 self tokens."""
    TOKENS = 64 * 3 + 8 + 1

    def __init__(self, d, layers, heads, **_):
        super().__init__()
        self.block = nn.Embedding(256, E)  # a class index, or 255 for unloaded
        self.near = nn.Conv3d(E, d, 4, 4)  # 16³ → 4³ patches
        self.mid = nn.Conv3d(E + 3, d, 4, 4)  # + water, lava, air flags
        self.far = nn.Conv2d(E + 3, d, 8, 8)  # 64² → 8² patches; + height, no-ground, water depth
        self.ent_type = nn.Embedding(256, d)  # hashed type, 0 = empty slot
        self.ent = nn.Linear(ENT, d)
        self.held = nn.Embedding(256, d)
        self.self_ = nn.Linear(SELF, d)
        self.pos = nn.Parameter(torch.randn(1, self.TOKENS, d) * 0.02)
        self.trunk = nn.TransformerEncoder(layer(d, heads, nn.TransformerEncoderLayer), layers, enable_nested_tensor=False)
        self.norm = nn.LayerNorm(d)

    def forward(self, near, mid, mid_flags, far_height, far_top, far_depth, ent_type, ent, self_vec, held):
        tok = lambda x: x.flatten(2).transpose(1, 2)
        n = self.block(near.long()).permute(0, 4, 1, 2, 3)
        bits = torch.stack([(mid_flags.float() / 2 ** b).floor() % 2 for b in range(3)], 1)  # no bitwise ops in ONNX
        m = torch.cat([self.block(mid.long()).permute(0, 4, 1, 2, 3), bits], 1)
        h = far_height.float()
        none = (h == -128).float()
        f = torch.cat([self.block(far_top.long()).permute(0, 3, 1, 2), (h * (1 - none) / 32)[:, None], none[:, None],
                       (far_depth.float() / 16)[:, None]], 1)
        e = self.ent_type(ent_type.long()) + self.ent(ent)
        s = (self.self_(self_vec) + self.held(held.long()))[:, None]
        x = torch.cat([tok(self.near(n)), tok(self.mid(m)), tok(self.far(f)), e, s], 1) + self.pos
        return self.norm(self.trunk(x))


class Query(nn.Module):
    """(encoded state, action, parameters, target) → the heads."""

    def __init__(self, d, heads, q_layers, n_actions, **_):
        super().__init__()
        self.action = nn.Embedding(n_actions, d)
        self.params = nn.Linear(P_NUM + P_CAT, d)
        self.target = nn.Linear(TARGET, d)
        self.dec = nn.TransformerDecoder(layer(d, heads, nn.TransformerDecoderLayer), q_layers)
        self.norm = nn.LayerNorm(d)
        self.outcome = nn.Linear(d, len(OUTCOMES))
        self.hazard = nn.Linear(d, BINS)
        self.disp = nn.Linear(d, 3)
        self.health = nn.Linear(d, 1)
        self.dense = nn.Linear(d, DENSE)

    def forward(self, tokens, action, params, target):
        q = (self.action(action) + self.params(params) + self.target(target))[:, None]
        h = self.norm(self.dec(q, tokens))[:, 0]
        return {'outcome': self.outcome(h), 'hazard': self.hazard(h), 'disp': self.disp(h),
                'health': self.health(h)[:, 0], 'dense': self.dense(h)}


STATE = ('near', 'mid', 'mid_flags', 'far_height', 'far_top', 'far_depth', 'ent_type', 'ent', 'self_vec', 'held')
OPTION = ('action', 'params', 'target')


class Tier1(nn.Module):
    def __init__(self, config, n_actions):
        super().__init__()
        c = CONFIGS[config]
        self.config, self.n_actions = config, n_actions
        self.encoder = Encoder(**c)
        self.query = Query(**c, n_actions=n_actions)

    def forward(self, b):
        return self.query(self.encoder(*(b[k] for k in STATE)), *(b[k] for k in OPTION))


def survival_loss(hazard, duration_s, event):
    """Discrete-time logistic hazard (Kvamme & Borgan): an action that ended in bin j survived every bin before it and
    ended in j; one cut off in bin j (timeout, episode end) only survived the bins before it."""
    j = (duration_s / BIN_S).long().clamp(0, BINS - 1)
    idx = torch.arange(BINS, device=hazard.device)
    survived = idx < j[:, None]
    ended = (idx == j[:, None]) & event[:, None]
    loss = F.binary_cross_entropy_with_logits(hazard, ended.float(), weight=(survived | ended).float(), reduction='none')
    return loss.sum(1)


def expected_duration(hazard):
    """Mean duration out to 20 s: Σ survival × bin width, with an action that ends in a bin counted to its middle."""
    surv = torch.cumsum(F.logsigmoid(-hazard), 1).exp()  # Π(1 − h), as a sum: ONNX has no cumprod
    before = torch.cat([torch.ones_like(surv[:, :1]), surv[:, :-1]], 1)
    return BIN_S * (before + surv).sum(1) / 2


def masked_mean(x, m):
    m = m.float()
    return (x * m).sum() / m.sum().clamp(min=1)


def losses(out, b):
    """Each head's loss, masked to the rows that have its label."""
    start = b['is_start']
    full = start & b['full']  # not cut off by the episode's end
    dense = out['dense']
    huber = lambda p, y: F.smooth_l1_loss(p, y, reduction='none', beta=0.1)
    return {
        'outcome': masked_mean(F.cross_entropy(out['outcome'], b['outcome'].clamp(min=0), reduction='none'), b['outcome'] >= 0),
        'duration': masked_mean(survival_loss(out['hazard'], b['duration_s'], b['event']), start),
        'disp': masked_mean(huber(out['disp'], b['end_disp']).sum(1), full),
        'health': masked_mean(huber(out['health'], b['dhealth']), full),
        'disp1': masked_mean(huber(dense[:, 0:3], b['disp1']).sum(1), b['m1']),
        'disp3': masked_mean(huber(dense[:, 3:6], b['disp3']).sum(1), b['m3']),
        'veto1': masked_mean(F.binary_cross_entropy_with_logits(dense[:, 6], b['veto1'], reduction='none'), b['m1']),
        'damage3': masked_mean(huber(dense[:, 7], b['damage3']), b['m3']),
    }
