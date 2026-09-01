.PHONY: help install drawio dev serve-lan token tray tray-icon tray-dmg tray-install app-linux docker-build docker-up docker-down docker-logs clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | sort | awk -F':.*## ' '{printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

install: ## Install Python dependencies via uv
	uv sync

drawio: ## Download + install the drawio webapp (~120 MB)
	bash scripts/install-drawio.sh

dev: ## Run the backend locally (http://127.0.0.1:8765)
	uv run devlog

serve-lan: ## Run the backend on all interfaces (reachable from phone / Tailnet)
	uv run devlog --host 0.0.0.0

token: ## Print the access token (used to log in from another device)
	@uv run devlog --print-token

tray: ## Build and launch the macOS app (requires Xcode CLT)
	cd clients/mac-tray && ./build.sh && open .build/Devlog.app

tray-icon: ## Regenerate the macOS app icon (AppIcon.icns) from AppIcon.svg
	cd clients/mac-tray && ./make-icon.sh

tray-dmg: ## Build a drag-to-Applications DMG installer (clients/mac-tray/.build/Devlog.dmg)
	cd clients/mac-tray && ./make-dmg.sh

tray-install: ## Build and install Devlog.app into /Applications (system-wide)
	cd clients/mac-tray && ./install.sh

tray-linux: ## Install the Linux tray (apt deps + ~/.local/bin launcher + autostart)
	bash clients/linux-tray/install.sh

app-linux: ## Install the Linux desktop app (GTK3 + WebKit2GTK window)
	bash clients/linux-app/install.sh

server-linux: ## Install the devlog backend as a systemd --user service (Ubuntu/Debian)
	bash clients/linux-server/install.sh

install-linux: server-linux tray-linux ## Backend service + tray, all-in-one Linux install

mcp: ## Run the devlog MCP server over stdio (for Claude Desktop / Code)
	uv run devlog-mcp

docker-build: ## Build the Docker image (includes drawio)
	docker compose build

docker-up: ## Start the container (data persists in ./data)
	docker compose up -d
	@echo
	@echo "  ➜  http://localhost:8765"
	@echo

docker-down: ## Stop the container
	docker compose down

docker-logs: ## Follow container logs
	docker compose logs -f devlog

backup: ## Hot-backup the local SQLite DB to ~/.local/share/devlog/backups/
	bash scripts/backup-db.sh --keep 20

smoke: ## Run end-to-end smoke test against http://127.0.0.1:8765
	uv run python scripts/smoke_test.py

clean: ## Remove build artifacts (keeps ./data and the SQLite DB)
	rm -rf .venv build dist *.egg-info clients/mac-tray/.build
	find . -name __pycache__ -type d -prune -exec rm -rf {} +
