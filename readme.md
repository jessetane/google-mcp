# gdrive-mcp
MCP proxy for Google Drive, Docs and Sheets HTTP APIs.  

## Why
Google's web assistant is OK but lacks the power and flexibility of a standalone agent, Claude has Drive but not Sheets, and ChatGPT requires a paid account.  

## How
* Handles OAuth2 sign-in, exchanges codes for Google tokens, and saves them locally in SQLite (`data.db`).  
* Issues an internal session token passed via `Authorization: Bearer <token>` to authenticate MCP calls.  
* Forwards Drive, Sheets, and Docs API requests directly to Google's endpoints, refreshing expired Google tokens on demand.  
* All data is stored unencrypted in local SQLite. Anyone with access to the host or database file can access stored tokens.  

## Setup
A Google Cloud project with OAuth credentials is required:

1. Enable the Google Drive, Docs and Sheets APIs in your Google Cloud project.  
2. Configure the OAuth consent screen.  
3. Create an OAuth 2.0 Client ID (Web application) and add `<APP_URL>/oauth/callback` to Authorized redirect URIs.  
4. Copy the Client ID and Client Secret into `.env`.  

## Usage

### ChatGPT
Go to **Plugins** → **New Plugin**:
* Enter `<APP_URL>/mcp`, name, and description.  
* OAuth is selected by default; complete the Google sign-in prompt when prompted.  

### Claude Desktop
Go to **Customize** → **Connectors**:
* Add a new connector with URL `<APP_URL>/mcp`.  
* OAuth is selected by default; approve the connection.  

### CLI Agents (Antigravity, Claude Code, etc.)
Sign in at `<APP_URL>/oauth/authorize` in your browser to get your session token, then add the MCP server with the `Authorization: Bearer <token>` header:

```json
{
	"mcpServers": {
		"gdrive": {
			"serverUrl": "http://localhost:8080/mcp",
			"headers": {
				"Authorization": "Bearer <token>"
			}
		}
	}
}
```

## Endpoints
```
POST /mcp                                       # json-rpc mcp endpoint
GET  /oauth/authorize                           # oauth redirect to google
GET  /oauth/callback                            # oauth callback handler
POST /oauth/token                               # token exchange proxy
GET  /.well-known/oauth-protected-resource      # rfc 9728 discovery
GET  /.well-known/oauth-authorization-server    # rfc 8414 discovery
GET  /api/health                                # health check
```
  
## Tools
* `driveApi` Proxy to `https://www.googleapis.com/drive/v3/{path}`  
* `docsApi` Proxy to `https://docs.googleapis.com/v1/{path}`  
* `sheetsApi` Proxy to `https://sheets.googleapis.com/v4/{path}`  
* `authStatus` Check Google token status  

## Install
```sh
$ git clone https://github.com/jessetane/gdrive-mcp.git
$ cd gdrive-mcp
$ npm install
$ cp .env.example .env
```
  
## Test
```sh
$ npm test
```

## License
MIT
