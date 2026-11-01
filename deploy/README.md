# Deploy: one GCE VM

`jeeve` (e2-standard-4, us-west1-b, Debian 12) runs `docker-compose.yml` from `/opt/jeeve`. The spectate page is
public at `https://35.197.6.238.sslip.io`; every POST needs basic auth. 25565 has no firewall rule and is reachable
only over Tailscale. SSH goes through IAP. Every command here uses the `jeeve` gcloud configuration:

```bash
g() { gcloud --configuration jeeve --quiet "$@"; }
```

## Secrets

`/opt/jeeve/.env` (mode 600) is both the Jeeves' `env_file` and compose's variables. Pipe it from the Mac so no copy
lands on disk anywhere else:

```bash
{ grep -E '^(ANTHROPIC_API_KEY|TYPESAFE_API_KEY|JUDGMENT_API_KEY|JUDGMENT_ORG_ID|JUDGMENT_API_URL|JEEVE_PROJECT)=' ../judgment/.env.jeeve
  grep '^JEEVE_BASIC_AUTH_HASH=' .env
  printf 'JEEVE_ENVIRONMENT=production\nMINECRAFT_EULA=true\nSITE_ADDRESS=35.197.6.238.sslip.io\n'
} | g compute ssh jeeve --tunnel-through-iap --command 'sudo sh -c "umask 077; cat > /opt/jeeve/.env"'
```

## Deploy and update

```bash
g compute ssh jeeve --tunnel-through-iap --command 'sudo bash -s' < deploy/setup.sh
```

The first run clones the repo, then stops until `.env` exists. Re-running pulls `main` and rebuilds. To join the
tailnet, pass a one-off key for that run only: `--command 'sudo TS_AUTHKEY=tskey-… bash -s'`, then connect to
`jeeve.<tailnet>.ts.net:25565`.

The Jeeves write what they learn to `/opt/jeeve/modules`, so the pull refuses to overwrite those files. Commit or
`git stash` them on the VM first.

## Rollback

`sudo git -C /opt/jeeve checkout <sha> && cd /opt/jeeve && sudo docker compose up -d --build`, or restore a
`jeeve-daily` snapshot (one a day, kept 7 days).

## Teardown

```bash
g compute instances delete jeeve --zone us-west1-b
g compute addresses delete jeeve-ip --region us-west1
g compute resource-policies delete jeeve-daily --region us-west1
g compute firewall-rules delete jeeve-web jeeve-iap-ssh
```
