# Introduction
Vendor Center is Jumia's new portal that will allow Jumia's sellers to manage all their shops in one stop, with one unique login.

**GPM API** was designed to allow sellers that manage their operations using ERPs / APIs to integrate with Vendor Center via API to manage their catalog on an end to end:
  - Create new products;
  - Update the content of their products;
  - Manage stock, price and status of their products;

For example, a typical call sequence of product creation includes:
  
  1.  Get Shops, Get Brands, Get Categories, Get Attributes - preparation of available basic data
  2.  Products Create Feed - returns the feed id
  3.  Feed Details - use the feed id to check if the feed is completed
  4.  Get Products - use the seller sku to check the product sid and the QC status


Regarding **GOP API**, it was designed to allow sellers that manage their operations using ERPs / APIs to integrate with Vendor Center via API to manage their orders end-to-end:

  - Get Orders and Order Items;
  - Cancel Order Items (if needed);
  - Pack and Ready to ship, including getting shipment providers and shipping labels.

> ***_NOTE:_***   If you find that some of your shops are not assigned to your mastershop in Vendor Center, please contact your account manager.

<div style="border-radius: 10px; background:  #f7f4f4; font-size: 12px; padding: 8px; border: 1px solid lightgray; margin: 25px;">
&#9432; <b>Glossary</b>
<p style="margin-left: 18px; margin-top: 2px"> 
  - Concept of <b><i>Feed</i></b>:
</p>
<p style="margin-left: 18px;"> 
  <b><i>Feed</i></b> is an aggregation of work which is parsed and processed individually, being it:
</p>
  <ul style="margin-left: 18px;">
    <li>A set of products which will be created asynchronously;</li>
    <li>A set of price/stock/status updates which will be processed asynchronously;</li>
  </ul>
<p style="margin-left: 18px; margin-top: 2px"> 
    - Concept of <b><i>mastershop</i></b>:
</p>
<p style="margin-left: 18px;"> 
  <b><i>mastershop</i></b> is the grouping of all your shops into one account. This grouping is done in 2 stages:
</p>
  <ol style="margin-left: 18px;">
    <li>Group all your shops created with the same email address across different countries - Global Shops;</li>
    <li>Group all Global Shops that belong to the same Main Account</li>
  </ol>  
</div>

# Getting started

Vendor Center's main goal is to provide a centralized place to manage your catalog and orders from all countries.
In practice, you will be able to manage all your orders within your Mastershop, even from different countries, in the same request.

## 1. Set up authentication

Every call to these APIs requires an Access Token. OAuth2 is the only supported way to integrate.

**Start at [Step-by-Step Authentication](#tag/Step-by-Step-Authentication).** It walks you through registering
an application in Vendor Center and obtaining your first token.

The first decision it asks you to make — **Self Authorization** or **Web Application** — cannot be changed
afterwards, so read that section before creating anything. In short: unattended integrations such as an ERP
or a scheduled job need **Self Authorization**; only pick **Web Application** if a person will be present to
log in through a browser.

## 2. Try the APIs

Both APIs can be tested:

[![Run in Postman](https://run.pstmn.io/button.svg)](https://app.getpostman.com/run-collection/27704663-644d32b7-68db-49cb-a139-f67189274485?action=collection%2Ffork&source=rip_markdown&collection-url=entityId%3D27704663-644d32b7-68db-49cb-a139-f67189274485%26entityType%3Dcollection%26workspaceId%3D40a238a0-e2dd-41ea-a216-a979f08d1576)

You will need to set your own Access Token in the collection's `bearerToken` environment variable.

Please follow the official documentation while testing the collection to ensure a thorough understanding of the all the paths parameters, query parameters and request body's of each endpoint.

### Rate Limits
While there are no limits in Seller Center regarding orders processing, Vendor Center will have it.
This rate limit is going to be applied at Mastershop level.
In a first stage, the limits will be **200 requests/minute with a limit of 4 requests / second**.

# Document Version Control
<!DOCTYPE html>
<html>
<style>
table, th, td {
  border:0px solid black;
  border-collapse: collapse;
  padding: 10px
}
</style>
<body>
<table style="width:100%;">
<caption style="white-space:nowrap;text-align: left;"><strong>GPM API Version Control</strong></caption>
  <tr style="background-color: #f7f4f4">
    <th style="text-align: center; padding: 10px">Version</th>
    <th>Released at:</th>
    <th>Changes</th>
  </tr>
  <tr>
    <td style="text-align: center;">Version 0.1</td>
    <td style="text-align: center;">2021-11-02</td>
    <td>Original document</td>
  </tr>
  <tr>
    <td style="text-align: center;">Version 0.2</td>
    <td style="text-align: center;">2021-11-26</td>
    <td> New APIs added:      
      <ul style="margin-left: 18px;">
          <li>GET Shops</li>
          <li>GET Brands</li>
          <li>GET Categories</li>
          <li>GET Attributes (per attribute set)</li>
          <li>GET Products</li>
          <li>POST Price update</li>
          <li>POST Status update</li>
          <li>GET Feed detail</li>
          <li>POST Create Products</li>
          <li>POST Update Products</li>
        </ul> 
    </td>  
  </tr>
    <tr>
    <td style="text-align: center;">Version 1</td>
    <td style="text-align: center;">2022-01-04</td>
    <td>   
      <ul style="margin-left: 18px;">
          <li>Create consignment request</li>
          <li>Update consignment request</li>
        </ul> 
    </td>  
  </tr>
    <tr>
    <td style="text-align: center;">Version 1.1</td>
    <td style="text-align: center;">2022-04-12</td>
    <td> New API added:      
      <ul style="margin-left: 18px;">
          <li>GET Stock</li>
        </ul> 
    </td>  
    </tr>
  </tr>
    <tr>
    <td style="text-align: center;">Version 1.2</td>
    <td style="text-align: center;">2022-05-11</td>
    <td>New query parameter on get products</td>
  </tr>
    </tr>
    <tr>
    <td style="text-align: center;">Version 1.3</td>
    <td style="text-align: center;">2022-08-29</td>
    <td> New APIs added:      
      <ul style="margin-left: 18px;">
          <li>GET Shops of MasterShop</li>
        </ul> 
    </td>
  </tr>
    <tr>
    <td style="text-align: center;">Version 2.0</td>
    <td style="text-align: center;">2026-08-11</td>
    <td> New API added:
      <ul style="margin-left: 18px;">
          <li>GET Sales Order Item</li>
        </ul>
    <p>The remaining entries are documentation corrected against the implementation. <b>No API behaviour changed</b> —
    the endpoints always behaved as described below; it was this document that was wrong.</p>
      <p><b>Breaking for anyone who built against the previous document:</b></p>
      <ul style="margin-left: 18px;">
          <li><b>GET Shops</b> and <b>GET Shops of MasterShop</b> return a JSON array directly. The
          <b>shops</b> wrapper object documented previously never existed.</li>
          <li><b>GET Shops</b> and <b>GET Shops of MasterShop</b>: <b>businessClients[].countryName</b> was
          documented as a required field but is not returned.</li>
      </ul>
      <p>New query parameters documented on <b>GET Products</b> (all already supported):</p>
      <ul style="margin-left: 18px;">
          <li><b>status</b> — filter by ACTIVE or INACTIVE</li>
          <li><b>qcStatus</b> — filter by QC status</li>
          <li><b>visible</b> — filter by visibility on the business client</li>
          <li><b>latestFirst</b> — return the most recently created products first</li>
      </ul>
      <p>Corrected on <b>GET Products</b>:</p>
      <ul style="margin-left: 18px;">
          <li><b>globalPrice.currency</b> and the business client price fields <b>localCurrency</b>,
          <b>localValue</b>, <b>currency</b> and <b>salePrice.localValue</b> are returned but were undocumented.
          All price fields are nullable.</li>
          <li><b>globalPrice.updateAt</b>, <b>businessClients[].price.updatedAt</b> and
          <b>businessClients[].statusUpdatedAt</b> were documented as required but are not returned.</li>
          <li><b>brand.code</b>, <b>category.code</b> and <b>additionalCategories[].code</b> are strings, not numbers.</li>
      </ul>
      <p>Other corrections:</p>
      <ul style="margin-left: 18px;">
          <li><b>GET Categories</b>: the <b>size</b> query parameter is supported but was undocumented.</li>
          <li><b>PATCH Consignment Order</b>: the third-party logistics field is <b>nameOf3PL</b>. Requests sending
          the previously documented <b>3plName</b> are accepted with 200 but that value is discarded.</li>
          <li><b>PATCH Consignment Order</b>: <b>actualDepartureDate</b> and <b>estimatedArrivalDate</b> use the
          format <b>yyyy-MM-dd</b>.</li>
          <li><b>POST Consignment Order</b>: <b>shippingDate</b> uses the format <b>yyyy-MM-dd HH:mm:ss</b>,
          which is not an ISO-8601 date-time.</li>
          <li>Timestamp fields across Products, Stock and Feed Detail are date-times, previously documented as dates.</li>
      </ul>
      <p><b>Corrected on GET Attributes:</b></p>
      <ul style="margin-left: 18px;">
          <li><b>validations</b> is a single object, previously documented as an array.</li>
          <li>The seven validation fields are <b>maxLength</b>, <b>minLength</b>, <b>dateFormat</b>,
          <b>selectedByDefault</b>, <b>decimalPlaces</b>, <b>percentage</b> and <b>notZeroOrNegative</b>. They were
          documented capitalised (<b>MaxLength</b>, <b>DateFormat</b>, …); those names are not returned. All seven are
          optional and only the rules relevant to the attribute's type are populated.</li>
          <li><b>type</b> is a <b>number</b>, not a string. The Attribute types table now gives the numeric value for
          each name, and <b>NUMBER_FLOAT</b> has been added — it was missing.</li>
          <li><b>options[].id</b> is a number. The uuid is a separate field, <b>sid</b>, which was undocumented.</li>
          <li><b>options[].status</b> and <b>options[].translations</b> are returned but were undocumented.</li>
      </ul>
      <p><b>Corrected on GET Categories:</b></p>
      <ul style="margin-left: 18px;">
          <li><b>attributeSet.sid</b> — documented as <b>attributeSet.id</b>, and marked required, so a strict
          validator rejected every valid response. Pass this value to GET Attributes.</li>
          <li><b>hasChildren</b> is returned but was undocumented.</li>
          <li>The <b>page</b> object (<b>current</b>, <b>totalOfPages</b>) is returned but was entirely undocumented,
          even though the endpoint is paginated.</li>
      </ul>
      <p><b>Error responses (all GPM endpoints):</b> the documented shape wrapped the payload in a <b>data</b> array.
      No endpoint returns that. The real shape depends on the service behind the endpoint, and there are three:</p>
      <ul style="margin-left: 18px;">
          <li>Catalog and Consignment return <b>{ code, message }</b>, where <b>code</b> is an internal error code,
          not the HTTP status.</li>
          <li>Shops and Feeds return <b>{ timestamp, status, error, path }</b>.</li>
          <li>Payments returns <b>{ message, status }</b>.</li>
      </ul>
    </td>
  </tr>
</table>
</body>
</html>

<!DOCTYPE html>
<html>
<style>
table, th, td {
  border:0px solid black;
  border-collapse: collapse;
  padding: 10px
}
</style>
<body>
<table style="width:100%;">
<caption style="white-space:nowrap;text-align: left;"><strong>GOP API and Authentication Endpoints Version Control</strong></caption>
  <tr style="background-color: #f7f4f4">
    <th style="text-align: center; padding: 10px">Version</th>
    <th>Released at:</th>
    <th>Changes</th>
  </tr>
  <tr>
    <td style="text-align: center;">Version 1.0</td>
    <td style="text-align: center;">2021-05-12</td>
    <td>Original document</td>
  </tr>
  <tr>
    <td style="text-align: center;">Version 1.1</td>
    <td style="text-align: center;">2021-05-20</td>
    <td>Added Consent page details on Obtain a Access Token for a Web Application session</td>  
  </tr>
    <tr>
    <td style="text-align: center;">Version 2.0</td>
    <td style="text-align: center;">2021-06-04</td>
    <td>Added Refresh Token Best Practices Section on Self Authorization description.
    <p>Added new API Endpoints: Get Order Items, Get Shipment Providers and Cancel.</p></td>
  </tr>
  <tr>
    <td style="text-align: center;">Version 3.0</td>
    <td style="text-align: center;">2021-06-25</td>
    <td> Added new API Endpoints: Create Package, Ready to Ship and Print Shipping Label.</td>  
  </tr>
  </tr>
    <tr>
    <td style="text-align: center;">Version 3.1</td>
    <td style="text-align: center;">2021-08-19</td>
    <td>Added <b>isLastPage</b> flag on Get Orders paginated.</td>
  </tr>
  </tr>
    <tr>
    <td style="text-align: center;">Version 4.0</td>
    <td style="text-align: center;">2022-02-22</td>
    <td>Added flag <b>requiredTrackingCode</b> to Get Shipment Providers API
    <p>Added field <b>trackingCode</b> to create package  API</p></td>
  </tr>
  </tr>
    <tr>
    <td style="text-align: center;">Version 5.0</td>
    <td style="text-align: center;">2022-03-17</td>
    <td>Added Version 2 for the /orders/pack API <b>(v2/orders/pack)</b>
    <p>Removed field <b>trackingCode</b> from the v1 <b>(/orders/pack)</b> endpoint</p></td>
  </tr>
  </tr>
    <tr>
    <td style="text-align: center;">Version 6.0</td>
    <td style="text-align: center;">2022-10-26</td>
    <td>Updated query parameters information (Get Refresh Token API).</td>
  </tr>
    <tr>
    <td style="text-align: center;">Version 7.0</td>
    <td style="text-align: center;">2026-08-11</td>
    <td>Documentation corrected against the implementation. <b>No API behaviour changed</b> — the endpoints always
    behaved as described below; it was this document that was wrong.
      <p><b>Breaking for anyone who built against the previous document:</b></p>
      <ul style="margin-left: 18px;">
          <li><b>Get Shipment Providers</b>: the flag is <b>trackingCodeRequired</b>. It was documented as
          <b>requireTrackingCode</b> (and as <b>requiredTrackingCode</b> in the Version 4.0 note above); neither name
          is returned. Clients reading either one saw <b>undefined</b> and could omit a tracking code that the
          provider requires.</li>
          <li><b>Print Shipping Label</b>: each label carries <b>orderItemIds</b>, not <b>orderItems</b>.</li>
          <li><b>v2/orders/pack</b>: each successful package carries <b>trackingCode</b>, not <b>trackingNumber</b>.</li>
      </ul>
      <p>Response fields that are returned but were undocumented:</p>
      <ul style="margin-left: 18px;">
          <li><b>countryCode</b> on the success entries of <b>Create Package</b>, <b>Ready to Ship</b>,
          <b>Print Shipping Label</b> and <b>Cancel</b>.</li>
      </ul>
      <p>Corrected on <b>Get Orders</b>:</p>
      <ul style="margin-left: 18px;">
          <li>The <b>country</b> filter accepts <b>CI, DZ, EG, GH, KE, MA, NG, SN, TN, UG, ZA</b>. <b>ZA</b> was
          missing from the previous list, and <b>CM</b> and <b>TZ</b> were listed but are not supported.</li>
          <li>There is no <b>ALL</b> status. The previous Order Item Status table listed one; omit the
          <b>status</b> parameter to retrieve every status. Unrecognised values are rejected with 400.</li>
          <li>The alternative name for <b>READY_TO_SHIP</b> is <b>ready_to_ship</b>, previously shown as
          <b>ready-to-ship</b>.</li>
          <li><b>status</b> and <b>country</b> are documented as comma-separated lists, matching how they already
          behaved.</li>
      </ul>
      <p>Other corrections:</p>
      <ul style="margin-left: 18px;">
          <li><b>Get Payout Statement</b>: <b>createdAt</b> and <b>updatedAt</b> use the format
          <b>yyyy-MM-dd HH:mm:ss</b>, which is not an ISO-8601 date-time.</li>
          <li><b>Get Order Items</b>: the price and exchange rate fields are numbers; the previous document carried
          descriptive text in their example values.</li>
      </ul>
      <p><b>Error responses (all GOP endpoints):</b> the documented shape wrapped the payload in a <b>data</b> array.
      No endpoint returns that. Two real shapes exist, depending on which handler catches the failure:</p>
      <ul style="margin-left: 18px;">
          <li><b>{ message, status }</b> for most failures, including authentication.</li>
          <li><b>{ timestamp, status, error, message }</b> for an invalid argument, access denied, or an unhandled
          server error.</li>
      </ul>
    </td>
  </tr>
    <tr>
    <td style="text-align: center;">Version 8.0</td>
    <td style="text-align: center;">2026-08-11</td>
    <td>Authentication section corrected against the implementation. <b>No API behaviour changed</b> — the
    endpoints always behaved as described below; it was this document that was wrong. The previous description
    dated from the earlier authorization server and was never updated.
      <p><b>Breaking for anyone who built against the previous document:</b></p>
      <ul style="margin-left: 18px;">
          <li><b>Obtain an Access Token</b>: <b>refresh_token</b> and <b>refresh_expires_in</b> are returned
          <b>only</b> to Self Authorization applications. A Web Application is registered for the
          <b>authorization_code</b> grant only and never receives them. The previous document listed both fields
          unconditionally, so clients read <b>undefined</b> and built on a token that never arrives.</li>
          <li><b>Obtain an Access Token</b>: the request body was documented with all six fields required at once.
          Each grant type now has its own field list — <b>authorization_code</b> takes <b>client_id</b>,
          <b>client_secret</b>, <b>code</b> and <b>redirect_uri</b>; <b>refresh_token</b> takes <b>client_id</b>
          and <b>refresh_token</b>.</li>
          <li><b>Redirect URI</b>: <b>code</b>, <b>state</b> and <b>session_state</b> arrive as <b>query string
          parameters</b>. They were documented as headers.</li>
      </ul>
      <p>Response fields that are returned but were undocumented:</p>
      <ul style="margin-left: 18px;">
          <li><b>id_token</b> and <b>scope</b> on <b>Obtain an Access Token</b>, for both grant types.</li>
      </ul>
      <p>Corrected elsewhere in the section:</p>
      <ul style="margin-left: 18px;">
          <li><b>Token lifetimes</b> are no longer published as fixed numbers. The previous document stated 12 hours
          for the Access Token and 1 year for the Refresh Token; both are configurable and the first is no longer
          accurate. Read <b>expires_in</b> and <b>refresh_expires_in</b> from the response instead.</li>
          <li><b>scope</b> on the Login endpoint is not restricted to <b>openid</b>. Every application is granted
          <b>openid email profile offline_access</b> regardless of what it requests. <b>The presence of
          offline_access does not mean a Refresh Token will be issued</b> — that depends only on the application
          type.</li>
          <li>The section now opens with the choice between <b>Self Authorization</b> and <b>Web Application</b>,
          which is fixed when the application is created and determines which grant type works, and closes with a
          troubleshooting table.</li>
      </ul>
      <p><b>Error responses (Login and Token endpoints):</b> these endpoints return the OAuth 2.0 error shape
      <b>{ error, error_description }</b>, not the shapes used by the GPM and GOP endpoints. The previous document
      pointed at the latter.</p>
    </td>
  </tr>
</table>
</body>
</html>
