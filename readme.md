# google-mcp
MCP proxy for Google HTTP APIs.

## Why
Gemini on the web is limited and lacks the power and flexibility of a standalone agent. Other frontier platforms may have "official" Google connectors but they are either paid-only, read-only or don't cover enough surface area to be truly useful.

## How
* **Auth**: An internal OAuth server manages interactive Google service scope selection and automatic token refreshes locally in SQLite.  
* **Proxy**: A single `google_api` MCP tool securely bridges HTTP calls directly to `*.googleapis.com`, giving agents near direct access to Google's REST APIs.  

## Setup
A Google Cloud project with OAuth credentials is required:

1. Enable the Google APIs you wish to use (Google Drive, Docs, Sheets, Slides, Forms, Calendar, Tasks, Keep, Meet, Gmail, Chat, People / Contacts, Photos, YouTube Data API v3, etc.) in your Google Cloud project.  
2. Configure the OAuth consent screen.  
3. Create an OAuth 2.0 Client ID (Web application) and add `<APP_URL>/oauth/callback` to Authorized redirect URIs.  
4. Copy the Client ID and Client Secret into `.env`.  

## Usage

### Authorization & Scope Selection

* **Interactive Scope Selection (Default for Claude & ChatGPT)**: Visiting `<APP_URL>/oauth/authorize` displays a consent screen where users select which Google services to enable. All services are **read-only by default**; checking the **Write** column grants full read/write privileges for that service.  
* **Presets**: Quick-select buttons are available for **All Read**, **All Write** (only affects services with read selected), and **None**.  
* **Enterprise Scopes**: Scopes marked with `*` (Google Keep) are restricted by Google to enterprise Workspace accounts and will fail if requested from a personal (`@gmail.com`) account.  

### ChatGPT
Go to **Plugins** → **New Plugin**:

* Enter `<APP_URL>/mcp`, name, and description.  
* OAuth is selected by default; complete the Google sign-in prompt when prompted.  

### Claude Desktop
Go to **Customize** → **Connectors**:

* Add a new connector with URL `<APP_URL>/mcp`.  
* Select "Sign in now" and "Use Claude's published identity".  

### CLI Agents (Antigravity, Claude Code, etc.)
Sign in at `<APP_URL>/oauth/authorize` in your browser to get your session token, then add the MCP server with the `Authorization: Bearer <token>` header:

```json
{
	"mcpServers": {
		"google": {
			"serverUrl": "<APP_URL>/mcp",
			"headers": {
				"Authorization": "Bearer <token>"
			}
		}
	}
}
```

## Tools

* **`auth_status`**: Returns whether the session is authenticated, the connected Google email, and granted scopes.  
* **`google_api`**: Direct HTTP caller to Google APIs (`*.googleapis.com`).  
  * `url`: Full URL (e.g. `https://www.googleapis.com/calendar/v3/calendars/primary/events`) or path (e.g. `drive/v3/files`).  
  * `method`: `GET`, `POST`, `PUT`, `PATCH`, `DELETE` (defaults to `GET`).  
  * `query`: Object with query parameters (e.g. `{ "q": "name contains 'Invoice'" }`).  
  * `body`: Object or string body for POST/PUT/PATCH requests.  
  * `headers`: Extra request headers (e.g. `{ "accept": "application/pdf" }`).  

## Endpoints
```
POST /mcp                                       # json-rpc mcp endpoint
GET  /oauth/authorize                           # oauth scope selection & sign-in screen
POST /oauth/authorize/consent                   # consent submission -> google oauth redirect
GET  /oauth/callback                            # oauth callback handler
POST /oauth/token                               # token exchange proxy
GET  /.well-known/oauth-protected-resource      # rfc 9728 discovery
GET  /.well-known/oauth-authorization-server    # rfc 8414 discovery
GET  /api/health                                # health check
```

## Install
```sh
$ git clone https://github.com/jessetane/google-mcp.git
$ cd google-mcp
$ npm install
$ cp .env.example .env
```
  
## Test
```sh
$ npm test
```

## License
MIT

