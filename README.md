
# Onixus Drayage OS

Full open source drayage TMS: Dispatch + Driver App + Tracking + StreetTurn + Client Portal + FMCSA + Port Data + MCPs

## MCP Servers
- email-mcp (Gmail/Outlook inbound parsing)
- crm-mcp (HubSpot/Salesforce sync)
- onyx-mcp (Doc intelligence via Ollama + LanceDB)
- business-email-mcp (YOUR domain dispatch@onixus.ai - SMTP/IMAP)
- business-crm-mcp (YOUR internal CRM for Shippers/Manufacturers/Brokers)

## Quick Start
cp .env.example .env
docker-compose up
# Web: http://localhost:3000, Email MCP: 4001, CRM MCP: 4002, ONYX: 4003, Business Email: 4004, Business CRM: 4005

## Deploy
./scripts/init-repo.sh
./scripts/init-supabase.sh
./scripts/init-vercel.sh

## StreetTurn
Implement your shipline interchange logic in packages/shared-types/streetTurn.ts
Function: findStreetTurnOpportunities(importLoad) -> exportLoad[]
