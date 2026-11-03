# wm/: the world model Jeeve runs

The Tier 1 outcome model's ONNX export (`train/export.py`): `encoder.onnx`, `query.onnx`, `model.json`. Not in git:
`deploy/setup.sh` copies them from `gs://jeeve-worlddata/models/<name>/` (default `2m-v3`, or `WM_MODEL=<name>`) and
the image bakes them in. On the Mac:

```bash
gcloud --configuration jeeve storage cp 'gs://jeeve-worlddata/models/2m-v3/*' wm/
```

Without them, or with `JEEVE_WM=0`, Jeeve runs without the model (brain/architecture/world-model-live.md).
