"""Reads one world-model episode (collect/format.ts): the header dict and numpy record arrays for steps and far views.
    python collect/read_episode.py episodes/train/<seed>/<file>.ep.gz   # prints a summary"""
import gzip, json, struct, sys
import numpy as np


def read_episode(path):
    data = gzip.open(path, 'rb').read()
    (n,) = struct.unpack_from('<I', data, 0)
    header = json.loads(data[4:4 + n])
    out, off = {'header': header}, 4 + n
    for part in ('steps', 'far'):
        dtype = np.dtype([(name, t, tuple(shape)) for name, t, shape in header[part]['fields']])
        assert dtype.itemsize == header[part]['record_bytes'], f'{part}: record size differs from the header'
        out[part] = np.frombuffer(data, dtype, header[part]['count'], off)
        off += dtype.itemsize * header[part]['count']
    assert off == len(data), 'file length does not match the header'
    return out


if __name__ == '__main__':
    ep = read_episode(sys.argv[1])
    h, s, f = ep['header'], ep['steps'], ep['far']
    print(json.dumps({k: h.get(k) for k in ('bot', 'seed', 'biome', 'end')} | {'steps': len(s), 'far': len(f),
                      'first_pos': s['pos'][0].round(2).tolist() if len(s) else None,
                      'actions': [(a['name'], a.get('outcome')) for a in h.get('actions', [])],
                      'near_classes': {h['classes'][c] if c < len(h['classes']) else 'unloaded': int(n) for c, n in zip(*np.unique(s['near'], return_counts=True))} if len(s) else {}}))
