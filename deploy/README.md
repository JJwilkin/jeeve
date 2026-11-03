# Deploy: one GCE VM

`jeeve` (e2-standard-4, us-west1-b, Debian 12) runs `docker-compose.yml` from `/opt/jeeve`. The spectate page is
public at `https://35.197.6.238.sslip.io`; every POST needs basic auth. 25565 has no firewall rule and is reachable
only over Tailscale. SSH goes through IAP. Run everything from the Mac's jeeve checkout, with the `jeeve` gcloud
configuration:

```bash
g() { gcloud --configuration jeeve --quiet "$@"; }
```

## Deploy and update

```bash
g compute ssh jeeve --tunnel-through-iap --command 'sudo bash -s' < deploy/setup.sh
```

The first run clones the repo to `/opt/jeeve`, then stops until the secrets are there (next section); run it again
after. Each later run pulls `main` and rebuilds.

To join the tailnet, send a one-off key down stdin ahead of the script, so it never lands in a command line, shell
history or log; then connect to `jeeve.<tailnet>.ts.net:25565`:

```bash
{ read -rs 'k?tskey: '; printf 'TS_AUTHKEY=%s\n' "$k"; cat deploy/setup.sh; } | g compute ssh jeeve --tunnel-through-iap --command 'sudo bash -s'
```

## The world model

`setup.sh` copies the Tier 1 model from `gs://jeeve-worlddata/models/2m-v3/` into `wm/` before building
(brain/architecture/world-model-live.md). Another export: `{ echo WM_MODEL=<name>; cat deploy/setup.sh; } | g compute ssh …`.
Off: `JEEVE_WM=0` in `/opt/jeeve/.env`, then `sudo docker compose up -d`. `docker compose logs jeeve-1 | grep '\[wm\]'`
shows what it predicted for each decision.

## Secrets

`/opt/jeeve/.env` (mode 600) is both the Jeeves' `env_file` and compose's variables. Collect it in shell memory and
send it only when all 10 lines are there, so a missing file can't replace a good `.env` with a partial one:

```bash
env=$({ grep -E '^(ANTHROPIC_API_KEY|TYPESAFE_API_KEY|JUDGMENT_API_KEY|JUDGMENT_ORG_ID|JUDGMENT_API_URL|JEEVE_PROJECT)=' ../judgment/.env.jeeve
  grep '^JEEVE_BASIC_AUTH_HASH=' .env
  printf 'JEEVE_ENVIRONMENT=production\nMINECRAFT_EULA=true\nSITE_ADDRESS=35.197.6.238.sslip.io\n'
}) && [ "$(printf '%s\n' "$env" | wc -l)" -eq 10 ] &&
  printf '%s\n' "$env" | g compute ssh jeeve --tunnel-through-iap --command 'sudo sh -c "umask 077; cat > /opt/jeeve/.env"'
```

## What the Jeeves learn

They write it to `modules/library.json` on the VM, so a deploy whose pull touches that file stops before rebuilding.
Bring the changes back to curate, then set them aside around the deploy:

```bash
g compute ssh jeeve --tunnel-through-iap --command 'sudo git -C /opt/jeeve diff modules' > learned.diff
g compute ssh jeeve --tunnel-through-iap --command 'sudo git -C /opt/jeeve stash'
g compute ssh jeeve --tunnel-through-iap --command 'sudo bash -s' < deploy/setup.sh
g compute ssh jeeve --tunnel-through-iap --command 'sudo git -C /opt/jeeve stash pop'
```

## Rollback

`sudo git -C /opt/jeeve checkout <sha> && cd /opt/jeeve && sudo docker compose up -d --build`, or restore a
`jeeve-daily` snapshot (one a day, kept 7 days). Run `sudo git -C /opt/jeeve checkout main` before the next deploy;
the pull fails on a detached HEAD.

## Rebuild from nothing

```bash
g services enable compute.googleapis.com iap.googleapis.com
g compute addresses create jeeve-ip --region us-west1
g compute instances create jeeve --zone us-west1-b --machine-type e2-standard-4 \
  --image-family debian-12 --image-project debian-cloud \
  --boot-disk-size 50GB --boot-disk-type pd-balanced --address jeeve-ip --tags jeeve
g compute firewall-rules delete default-allow-ssh default-allow-rdp
g compute firewall-rules create jeeve-web --network default --direction INGRESS \
  --allow tcp:80,tcp:443 --source-ranges 0.0.0.0/0 --target-tags jeeve
g compute firewall-rules create jeeve-iap-ssh --network default --direction INGRESS \
  --allow tcp:22 --source-ranges 35.235.240.0/20 --target-tags jeeve
g compute resource-policies create snapshot-schedule jeeve-daily --region us-west1 \
  --daily-schedule --start-time 08:00 --max-retention-days 7
g compute disks add-resource-policies jeeve --zone us-west1-b --resource-policies jeeve-daily
```

A new static IP changes `SITE_ADDRESS` and the spectate URL.

## Teardown

```bash
g compute instances delete jeeve --zone us-west1-b
g compute addresses delete jeeve-ip --region us-west1
g compute resource-policies delete jeeve-daily --region us-west1
g compute firewall-rules delete jeeve-web jeeve-iap-ssh
```
