#!/usr/bin/env bash
set -euo pipefail

root=$1
release_id=$2
setup_ingress=$3
ingress_container=$4
ingress_config=$5

stage="$root/incoming/$release_id"
site="$root/site"
previous=""
switched=0
ingress_changed=0
backend_changed=0

exec 9>"$root/.deploy.lock"
flock -n 9 || { echo 'Another Loom deployment is running.' >&2; exit 1; }

rollback() {
  local status=$?
  if (( status == 0 )); then return; fi
  set +e
  echo 'Deployment failed; restoring the previous site and ingress configuration.' >&2
  if (( ingress_changed )); then
    cp "$stage/ingress.previous" "$ingress_config"
    sudo -n docker exec "$ingress_container" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile || true
  fi
  if (( switched )); then
    if [[ -n "$previous" ]]; then
      ln -s "$previous" "$site/.rollback-$release_id"
      mv -Tf "$site/.rollback-$release_id" "$site/current"
    else
      # Only remove the exact symlink this deployment created.
      if [[ -L "$site/current" && "$(readlink "$site/current")" == "releases/$release_id" ]]; then
        unlink "$site/current"
      fi
    fi
  fi
  if (( backend_changed )) && [[ -f "$stage/previous-backend/compose.yaml" && -f "$stage/previous-backend/Caddyfile" && -f "$stage/previous-backend/deploy.env" ]]; then
    cp "$stage/previous-backend/compose.yaml" "$root/compose.yaml"
    cp "$stage/previous-backend/Caddyfile" "$root/config/Caddyfile"
    cp "$stage/previous-backend/deploy.env" "$root/deploy.env"
    sudo -n docker compose --project-directory "$root" --env-file "$root/deploy.env" -f "$root/compose.yaml" up -d --pull never --wait --wait-timeout 60 website
    sudo -n docker compose --project-directory "$root" --env-file "$root/deploy.env" -f "$root/compose.yaml" exec -T website caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
  fi
  exit "$status"
}
trap rollback EXIT

sudo -n docker compose --project-directory "$root" --env-file "$stage/deploy.env" -f "$stage/compose.yaml" config --quiet
# Check prerequisites before changing the currently served release.
network=$(sed -n 's/^LOOM_INGRESS_NETWORK=//p' "$stage/deploy.env")
image=$(sed -n 's/^LOOM_CADDY_IMAGE=//p' "$stage/deploy.env")
sudo -n docker network inspect "$network" >/dev/null
sudo -n docker image inspect "$image" >/dev/null
sudo -n docker exec "$ingress_container" caddy version
(cd "$stage/site" && sha256sum --quiet -c "$stage/SHA256SUMS")

if [[ "$setup_ingress" == 1 ]]; then
  # Refuse to overwrite an ingress file changed since the local preflight.
  cmp --silent "$stage/ingress.previous" "$ingress_config" || { echo 'Ingress configuration changed; run the deployment again.' >&2; exit 1; }
  sudo -n docker cp "$stage/ingress.Caddyfile" "$ingress_container:/tmp/loom-$release_id.Caddyfile"
  sudo -n docker exec "$ingress_container" caddy validate --config "/tmp/loom-$release_id.Caddyfile" --adapter caddyfile
fi

mkdir -p "$site/releases" "$root/config"
if [[ -L "$site/current" ]]; then
  previous=$(readlink "$site/current")
elif [[ -e "$site/current" ]]; then
  echo 'The current site path exists and is not a symlink; refusing to replace it.' >&2
  exit 1
fi
[[ ! -e "$site/releases/$release_id" ]] || { echo 'Release already exists.' >&2; exit 1; }
mv "$stage/site" "$site/releases/$release_id"
mkdir -p "$stage/previous-backend"
for filename in compose.yaml deploy.env; do
  if [[ -f "$root/$filename" ]]; then cp "$root/$filename" "$stage/previous-backend/$filename"; fi
done
if [[ -f "$root/config/Caddyfile" ]]; then cp "$root/config/Caddyfile" "$stage/previous-backend/Caddyfile"; fi
backend_changed=1
cp "$stage/compose.yaml" "$root/compose.yaml"
cp "$stage/Caddyfile" "$root/config/Caddyfile"
cp "$stage/deploy.env" "$root/deploy.env"
ln -s "releases/$release_id" "$site/.current-$release_id"
mv -Tf "$site/.current-$release_id" "$site/current"
switched=1

sudo -n docker compose --project-directory "$root" --env-file "$root/deploy.env" -f "$root/compose.yaml" up -d --pull never --wait --wait-timeout 60 website
sudo -n docker compose --project-directory "$root" --env-file "$root/deploy.env" -f "$root/compose.yaml" exec -T website caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
sudo -n docker exec "$ingress_container" wget -q -O /dev/null http://loom-website:80/deployment.json

if [[ "$setup_ingress" == 1 ]]; then
  cmp --silent "$stage/ingress.previous" "$ingress_config" || { echo 'Ingress configuration changed during activation; refusing to overwrite it.' >&2; exit 1; }
  ingress_changed=1
  # Preserve the inode: the existing Caddy container bind-mounts this file.
  cp "$stage/ingress.Caddyfile" "$ingress_config"
  sudo -n docker exec "$ingress_container" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
fi

switched=0
ingress_changed=0
backend_changed=0
printf '\nOrigin deployed successfully: %s\n' "$release_id"
printf 'Previous release: %s\n' "${previous:-none}"
