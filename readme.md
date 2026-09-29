# google-mcp
MCP proxy for Google HTTP APIs.

## Why
Gemini on the web is limited and lacks the power and flexibility of a standalone agent. Other frontier platforms may have "official" Google connectors but they are either paid-only, read-only or don't cover enough surface area to be truly useful.

## How
* **Auth**: An internal OAuth server manages interactive Google service scope selection and automatic token refreshing.  
* **Proxy**: A single `google_api` MCP tool bridges HTTP calls to `*.googleapis.com`, giving agents near direct access to Google's REST APIs.  

## Setup
A Google Cloud project with OAuth credentials is required:

1. Enable the Google APIs you wish to use (Google Drive, Docs, Sheets, Slides, Forms, Calendar, Tasks, Keep, Meet, Gmail, Chat, People / Contacts, Photos, YouTube Data API v3, etc.) in your Google Cloud project.  
2. Configure the OAuth consent screen.  
3. Create an OAuth 2.0 Client ID (Web application) and add `<APP_URL>/oauth/callback` to Authorized redirect URIs.  
4. Copy the Client ID and Client Secret into `.env`.  

## Usage

### ChatGPT
Go to **Plugins** → **New Plugin**:

* Enter `<APP_URL>/mcp`, name, and description.  
* OAuth is selected by default, no customization is necessary.

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

### Authorization & Access Control

* **Scope Selection**: Visiting `<APP_URL>/oauth/authorize` displays a consent screen to select which Google services to enable (unchecked by default). Checking **Write** grants write privileges.  
* **Session Administration (`auth` tool)**: Optional toggle granting permission to list and revoke sessions. When disabled (default), the `auth` tool is omitted from `tools/list` and sessions are restricted to domain API access.  
* **Granular Policy Engine (JSON)**: Optional JSON policy attached to the token to restrict sub-resources, URLs, and HTTP methods beyond Google OAuth scopes:

```json
[
	{
		"action": "allow",
		"methods": ["GET"],
		"path": "/calendar/v3/calendars/team-schedule@group.calendar.google.com"
	},
	{
		"action": "allow",
		"path": "/calendar/v3/calendars/team-schedule@group.calendar.google.com/events/**"
	}
]
```

## Tools

* **`auth`**: Inspect authentication status, list active sessions for current user, get session details, or revoke sessions (available to admin sessions).  
  * `action`: `'whoami'` (or `'status'`, default), `'list'`, `'get'`, or `'revoke'`.  
  * `sessionId`: Optional session ID when action is `'get'` or `'revoke'`.  
  * `allOthers`: Optional boolean to revoke all other active sessions when action is `'revoke'`.  
* **`google_api`**: HTTP proxy to Google APIs (`*.googleapis.com`).  
  * `url`: Full URL (e.g. `https://www.googleapis.com/calendar/v3/calendars/primary/events?q=meeting`) or relative path with query parameters (e.g. `drive/v3/files?pageSize=10`).  
  * `method`: `GET`, `POST`, `PUT`, `PATCH`, `DELETE` (defaults to `GET`).  
  * `body`: Object or string body for POST/PUT/PATCH requests.  
  * `headers`: Extra request headers (e.g. `{ "accept": "application/pdf" }`).  

## Endpoints
```
POST   /mcp                                       # json-rpc mcp endpoint
GET    /oauth/authorize                           # oauth scope selection & sign-in screen
POST   /oauth/authorize/consent                   # consent submission -> google oauth redirect
GET    /oauth/callback                            # oauth callback handler
POST   /oauth/token                               # token exchange proxy
POST   /oauth/revoke                              # rfc 7009 token revocation
GET    /.well-known/oauth-protected-resource      # rfc 9728 discovery
GET    /.well-known/oauth-authorization-server    # rfc 8414 discovery
GET    /api/health                                # health check
GET    /api/whoami                                # inspect auth state, identity, scopes, policy & session
GET    /api/sessions                              # list active sessions for authenticated user
DELETE /api/sessions                              # revoke current session (or ?allOthers=true)
GET    /api/sessions/:id                          # get specific session details
DELETE /api/sessions/:id                          # revoke specific session
ALL    /api/google/*                              # transparent google api proxy
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

