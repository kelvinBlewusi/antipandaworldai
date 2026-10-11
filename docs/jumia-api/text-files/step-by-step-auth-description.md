To integrate with the Vendor Center APIs you register an **application** in Vendor Center, then exchange its credentials for an **Access Token** that you send on every API call.

## Step 1 — Choose your application type

This is the most important decision in the whole setup. **It cannot be changed after the application is created**, and it determines how you obtain tokens for the rest of the integration.

| | **Self Authorization** | **Web Application** |
|---|---|---|
| Use it when | Your integration runs unattended — an ERP, a script, a scheduled job. No human is present to log in. | Your integration has a user interface and can send a person to a login page in their browser. |
| You need to provide | A name | A name **and** a Redirect URI |
| You receive | Client Id, and a Refresh Token generated on demand | Client Id, Client Secret, Redirect URI |
| `grant_type` you will use | `refresh_token` | `authorization_code` |
| Does `POST /token` return a `refresh_token`? | **Yes**, a new one on every call | **No — never.** See [Step 4](#tag/Step-by-Step-Authentication) |
| When the Access Token expires | Exchange your stored Refresh Token for a new one, with no user involved | Send the user through the login prompt again |

<p class="noteBoxes type1"><img src="images/exclamation-triangle-solid.png" class="picture"><b>Most integrations should choose Self Authorization.</b> If your system talks to Jumia on a schedule, or in the background, or without a person sitting in front of it, pick Self Authorization. Choosing Web Application means your integration stops working every time the Access Token expires until somebody logs in again.</p>

## Step 2 — Register the application

1. Go to Vendor Center — [Live](https://vendorcenter.jumia.com/) or [Staging](https://vendorcenter-staging.jumia.com/).
2. Click **Settings**.
3. Open **Applications** to reach the *Manage Applications* screen.
4. Click **Create Application**.
5. Select the authorization type you chose in Step 1:

<center><img src="images/apiDoc1.png" width="500" height="300" alt="Create Application dialog showing the authorization type options" /></center>

### If you chose Web Application

Provide a name and the **Redirect URI** — the address on your own server that our authorization server will send the user back to after they log in. It must match exactly, character for character, on every request you make later.

After submitting you receive:

<center><img src="images/apiDoc2.png" width="400" height="300" alt="Application details popup showing the generated credentials" /></center>

1. The application name you chose.
2. A generated **Client Id**.
3. A generated **Client Secret**.
4. The **Redirect URI** you entered.

<p class="noteBoxes type1"><img src="images/exclamation-triangle-solid.png" class="picture"><b>Save the Client Secret before closing this popup.</b> It is shown once and cannot be retrieved afterwards. If you lose it, you have to create a new application.</p>

### If you chose Self Authorization

Provide a name. There is no Redirect URI and no Client Secret to save.

### Reviewing your applications

The *Manage Applications* screen lists your active applications and lets you manage them.

<center><img src="images/apiDoc3.png" width="1000" height="350" alt="Manage Applications screen listing existing applications" /></center>

## Step 3 — Obtain an Access Token

### Self Authorization

You start from a Refresh Token that you generate in the UI, and exchange it for Access Tokens for as long as your integration runs. No browser is involved at any point.

1. On the *Manage Applications* screen, find your application.
2. In the **Actions** column, click the **Generate Token** icon.
3. Copy the Refresh Token and store it securely in your integration.

<center><img src="images/apiDoc4.png" width="400" height="300" alt="Generate Token action on the Manage Applications screen" /></center>

4. Call the [Token endpoint](#tag/Endpoints/operation/post-token) with `grant_type=refresh_token` to obtain an Access Token.

<p class="noteBoxes type2"><img src="images/lightbulb.png" class="picture1"><b>Always store the new Refresh Token</b></br></br>Every successful call returns a <b>new</b> <code>refresh_token</code> alongside the Access Token, and it replaces the one you sent. Overwrite your stored copy each time.</br></br>If you keep reusing the original token instead, it will eventually expire and your integration will stop authenticating. Read <code>refresh_expires_in</code> from the response to see how long the current one is valid for.</p>

### Web Application

1. Redirect the user's browser to the [Login endpoint](#tag/Endpoints/operation/get-login).

<center><img src="images/apiDoc5.png" width="600" height="400" alt="Vendor Center login prompt" /></center>

2. The first time a given user goes through this flow, our authorization server shows a consent page.

<center><img src="images/apiDoc6.png" width="600" height="400" alt="Consent page shown on first authorization" /></center>

3. After a successful login and consent, our authorization server redirects the browser to your [Redirect URI](#tag/Endpoints/operation/get-Application-Redirect-URI), with a one-time **Authorization Code** in the query string.
4. Read `code` from the query string and exchange it at the [Token endpoint](#tag/Endpoints/operation/post-token) with `grant_type=authorization_code`. The code is single-use — exchange it immediately.

## Step 4 — Understand what you get back

A successful call to the [Token endpoint](#tag/Endpoints/operation/post-token) always returns `access_token`, `token_type`, `expires_in`, `scope` and `id_token`.

`refresh_token` and `refresh_expires_in` are returned **only to Self Authorization applications**.

<p class="noteBoxes type1"><img src="images/exclamation-triangle-solid.png" class="picture"><b>Web Applications never receive a refresh_token, and the returned scope is misleading on this point.</b> Vendor Center grants <code>openid email profile offline_access</code> to every application regardless of what you request. On most OAuth2 servers <code>offline_access</code> implies a Refresh Token will follow — here it does not. If you need tokens without a user present, you need a Self Authorization application.</p>

### Token lifetimes

**Read `expires_in` from the response and refresh shortly before it elapses.** Do not hardcode a duration — it is configurable per environment, has changed in the past, and is becoming configurable per application.

The same applies to `refresh_expires_in` for Self Authorization applications.

## Step 5 — Call the API

Send the Access Token in the header of every request:

```
Authorization: Bearer <access_token>
```

Tokens are JSON Web Tokens (JWT). Requests made without a valid token fail with `401 Unauthorized`.

## Troubleshooting

| What you see | What it means | What to do |
|---|---|---|
| The response has no `refresh_token`, even though `scope` contains `offline_access` | Your application is a **Web Application**. This type never receives one. | Send the user through the [Login endpoint](#tag/Endpoints/operation/get-login) again when the token expires. For unattended access, create a **Self Authorization** application instead. |
| `400 unauthorized_client` | You sent a `grant_type` your application is not registered for. | Web Applications use `authorization_code`; Self Authorization applications use `refresh_token`. The type cannot be changed — create a new application if you picked the wrong one. |
| `400 invalid_grant` on `authorization_code` | The Authorization Code expired or was already used. Codes are single-use. | Restart the flow at the [Login endpoint](#tag/Endpoints/operation/get-login) and exchange the new code immediately. |
| `400 invalid_grant` on `refresh_token` | The Refresh Token expired, or was replaced by a newer one from a later call. | Use the most recent Refresh Token you received. If none works, generate a new one from **Generate Token** in Vendor Center. |
| `400 invalid_request` mentioning `redirect_uri` | The `redirect_uri` does not exactly match the one registered for the application. | Compare them character for character, including scheme, trailing slash and port. |
| `401 invalid_client` | The `client_id` or `client_secret` is wrong. | The Client Secret is shown only once at creation. If it was not saved, create a new application. |
| `401 Unauthorized` on an API call that used to work | The Access Token expired. | Obtain a new one as described in Step 3. Read `expires_in` rather than assuming a fixed lifetime. |

<p class="noteBoxes type1"><img src="images/exclamation-triangle-solid.png" class="picture">Authenticating as a different user in the same browser replaces the previous session. The earlier <b>access_token</b> and <b>refresh_token</b> stop being valid.</p>

<link href="style.css" rel="stylesheet" type="text/css"/>
