# Execution and lab limits

Only the broker owns the host Docker socket. Workers run without that socket, credentials, host mounts, extra capabilities, or sudo. Commands use `sandbox_exec`. Direct harness shell tools are blocked. File tools are confined to `/workspace/tasks/<task-id>`, with read-only access to packaged skills and workflows.

`NEO_EXEC_NETWORK=none` is the default. Set `lab` to allow commands to reach authorized containers owned by the same task. External arbitrary network scanners, host VPN devices, privileged containers, and mobile hardware are unsupported in this broker. Browser HTTP requests and traffic replay use the broker's current task policy and DNS checks. Browser pages have no direct external network path.

`deploy_up` accepts an image or strict image-only Compose YAML or JSON with an explicit endpoint port. It rejects Dockerfile and Git builds, bind mounts, privileged settings, custom networks, public ports, and unsupported Compose fields. Example: image `node:22.23.3-bookworm-slim`, deployment id `lab`, service `app`, port `3000`, with a service command that listens there. The returned endpoint becomes available after a readiness check. Allowlist its `lab-app` alias explicitly. Failed setup rolls back its containers. `deploy_down` targets persisted task-owned resources.

The optional Juice Shop profile attaches to the task lab network. Its alias must be approved for the task. HTTP out-of-band testing uses generated Interactsh payloads through the broker callback relay. DNS out-of-band testing requires separately configured callback DNS and is disabled by default.

Service boundaries, backups, and the capability manifest are in [Operations](operations.md). The broker's own rules are in the [broker README](../broker/README.md).
