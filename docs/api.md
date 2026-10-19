# AstroviaBin API Documentation

This document describes the REST API endpoints available in AstroviaBin.

## Base URL

All API endpoints are relative to your AstroviaBin server's base URL:
```
http://localhost:5000/api
```

## Authentication

Every page and API route requires a signed-in session, except `GET /api/health`, `GET /api/auth/status` and the login page.

- `GET /login` — HTML sign-in form. `POST /login` with form fields `user`, `password` and optional `next` sets the `astroviabin_session` cookie (HttpOnly, SameSite=Lax, 30 days). Ten failed attempts per client address within 15 minutes are throttled.
- `POST /api/auth/logout` — clears the session cookie.
- `GET /api/auth/me` — `{ "username": "krory90", "role": "admin", "builtin": true, "authEnabled": true }`.

Requests without a valid session receive `401`. Roles are checked on every request:

| Role | Can do |
|---|---|
| `admin` | Everything, including `/api/admin/*`, `/api/users/*`, catalog reloads and solver checks |
| `editor` | Read everything and change content (uploads, edits, plate solving, catalogs, stacking, HOTPANTS) |
| `viewer` | Read-only (`GET`/`HEAD`) |

Forbidden actions return `403`. The built-in administrator comes from `ASTROVIABIN_ADMIN_USER` / `ASTROVIABIN_ADMIN_PASSWORD` (default `admin` / `admin`). The WebSocket at `/ws` requires the same session cookie.

## Response Format

All API responses return JSON with the following general structure:

**Success Response:**
```json
{
  "data": {...},
  "message": "Operation successful"
}
```

**Error Response:**
```json
{
  "message": "Error description",
  "error": "Additional error details"
}
```

## Endpoints

### Images

#### Get All Images
```
GET /api/images
```

**Query Parameters:**
- `objectType` (string) - Filter by object type
- `tags` (string|array) - Filter by tags
- `plateSolved` (boolean) - Filter by plate solving status
- `constellation` (string) - Filter by constellation

**Response:**
```json
[
  {
    "id": 1,
    "immichId": "uuid",
    "title": "M31 Andromeda Galaxy",
    "filename": "m31.jpg",
    "thumbnailUrl": "/api/assets/uuid/thumbnail",
    "fullUrl": "/api/assets/uuid/thumbnail?size=preview",
    "captureDate": "2023-10-15T22:30:00Z",
    "focalLength": 600,
    "aperture": "f/5.6",
    "iso": 1600,
    "exposureTime": "300s",
    "plateSolved": true,
    "ra": "0.712",
    "dec": "41.269",
    "constellation": "Andromeda",
    "tags": ["galaxy", "deep-sky"],
    "objectType": "Galaxy"
  }
]
```

#### Get Single Image
```
GET /api/images/{id}
```

**Parameters:**
- `id` (integer) - Image ID

**Response:** Single image object (same structure as above)

#### Update Image
```
PATCH /api/images/{id}
```

**Parameters:**
- `id` (integer) - Image ID

**Request Body:**
```json
{
  "title": "Updated title",
  "objectType": "Galaxy",
  "tags": ["galaxy", "messier"],
  "description": "Updated description"
}
```

**Response:** Updated image object

### Plate Solving

#### Submit Image for Plate Solving
```
POST /api/plate-solving/images/{id}/plate-solve
```

Queues a private local Astrometry.net solve (`202`). Images need the `Deep Sky` tag or an existing stellar solution; Solar System images are rejected.

**Optional request body** (RA as degrees or `hh:mm:ss`, Dec as degrees or `±dd:mm:ss`; scale in arcsec/pixel):
```json
{ "hint": { "ra": "12:05:15", "dec": "+76:54:21", "radius": 3, "scaleLow": 0.5, "scaleHigh": 1.5 } }
```

Without a hint the solver tries the previous solution, the FITS pointing keywords and M/NGC/IC names in the title, then searches blind.

**Response (`202`):**
```json
{
  "status": "processing",
  "jobId": 54,
  "submissionId": "local-3146aa61-13e5-4aa1-9e55-45c1c9ba1ee0",
  "message": "Queued for private local solving. This can take several minutes for large images."
}
```

Jobs are `pending` while queued and `processing` while the worker solves them (one at a time).

#### Get Plate Solving Jobs
```
GET /api/plate-solving/jobs
```

**Response:**
```json
[
  {
    "id": 1,
    "imageId": 1,
    "astrometrySubmissionId": "12345",
    "astrometryJobId": "67890",
    "status": "success",
    "submittedAt": "2023-10-15T22:30:00Z",
    "completedAt": "2023-10-15T22:35:00Z",
    "result": {
      "ra": 10.684,
      "dec": 41.269,
      "pixscale": 2.77
    }
  }
]
```

#### Bulk Submit for Plate Solving

Body: `{ "imageIds": [1, 2], "force": false }`. `force: true` re-solves images that already have a solution (the previous solution is kept until the new one succeeds).

```
POST /api/plate-solving/bulk
```

**Request Body:**
```json
{
  "imageIds": [1, 2, 3, 4, 5]
}
```

**Response:**
```json
{
  "message": "Bulk plate solving submission completed",
  "results": [
    {
      "imageId": 1,
      "success": true,
      "submissionId": "12345",
      "jobId": 1,
      "message": "Submitted for plate solving"
    },
    {
      "imageId": 2,
      "success": false,
      "error": "Image already plate solved"
    }
  ]
}
```

#### Get Image Annotations
```
GET /api/images/{id}/annotations
```

For local solves (`"source": "wcs"`) every OpenNGC object overlapping the field is projected through the stored WCS (TAN + SIP). `pixelx`/`pixely` are native-image content coordinates: `(0, 0)` is the top-left corner of the first pixel, so an overlay sits at `pixelx / imageDimensions.width`. `radius` is in pixels (half the catalogue major axis).

Imported solutions without a stored WCS return `"source": "legacy"` with positions scaled to native pixels and a `message` suggesting a local re-solve.

**Response:**
```json
{
  "annotations": [
    {
      "type": "ngc",
      "objectType": "G",
      "names": ["NGC 253", "Sculptor Filament", "Silver Coin"],
      "ra": 11.888,
      "dec": -25.288222,
      "pixelx": 4785.88,
      "pixely": 3182.44,
      "radius": 1077.1,
      "vmag": 7.09
    }
  ],
  "calibration": { "ra": 11.8876, "dec": -25.2858, "pixscale": 0.746, "radius": 1.19, "orientation": 180.2, "parity": -1 },
  "imageDimensions": { "width": 9576, "height": 6388 },
  "source": "wcs"
}
```

### Equipment

#### Get All Equipment
```
GET /api/equipment
```

**Response:**
```json
[
  {
    "id": 1,
    "name": "Celestron EdgeHD 11",
    "type": "telescope",
    "specifications": {
      "aperture": "279mm",
      "focalLength": "2800mm",
      "focalRatio": "f/10"
    },
    "description": "Schmidt-Cassegrain telescope",
    "createdAt": "2023-10-15T22:30:00Z",
    "updatedAt": "2023-10-15T22:30:00Z"
  }
]
```

#### Create Equipment
```
POST /api/equipment
```

**Request Body:**
```json
{
  "name": "Canon EOS R5",
  "type": "camera",
  "specifications": {
    "sensor": "Full Frame",
    "resolution": "45MP",
    "pixelSize": "4.39μm"
  },
  "description": "Mirrorless camera for astrophotography"
}
```

**Response:** Created equipment object

#### Update Equipment
```
PUT /api/equipment/{id}
```

**Parameters:**
- `id` (integer) - Equipment ID

**Request Body:** Same as create equipment

**Response:** Updated equipment object

#### Delete Equipment
```
DELETE /api/equipment/{id}
```

**Parameters:**
- `id` (integer) - Equipment ID

**Response:**
```json
{
  "message": "Equipment deleted successfully"
}
```

#### Get Equipment for Image
```
GET /api/images/{id}/equipment
```

**Parameters:**
- `id` (integer) - Image ID

**Response:**
```json
[
  {
    "id": 1,
    "name": "Celestron EdgeHD 11",
    "type": "telescope",
    "specifications": {...},
    "settings": {
      "focalLength": 2800,
      "focalRatio": "f/10"
    },
    "notes": "Used with field flattener"
  }
]
```

#### Add Equipment to Image
```
POST /api/images/{id}/equipment
```

**Parameters:**
- `id` (integer) - Image ID

**Request Body:**
```json
{
  "equipmentId": 1,
  "settings": {
    "focalLength": 2800,
    "focalRatio": "f/10"
  },
  "notes": "Used with field flattener"
}
```

**Response:** Image-equipment relationship object

#### Remove Equipment from Image
```
DELETE /api/images/{imageId}/equipment/{equipmentId}
```

**Parameters:**
- `imageId` (integer) - Image ID
- `equipmentId` (integer) - Equipment ID

**Response:**
```json
{
  "message": "Equipment removed from image"
}
```

### Admin & Configuration

#### Get Admin Settings
```
GET /api/admin/settings
```

**Response:**
```json
{
  "astrometry": {
    "enabled": true,
    "autoEnabled": false,
    "checkInterval": 30,
    "pollInterval": 5,
    "maxConcurrent": 3,
    "autoResubmit": false
  },
  "sidecar": { "enabled": true, "outputPath": "/app/sidecars", "organizeByDate": true },
  "app": { "debugMode": false }
}
```

#### Update Admin Settings
```
POST /api/admin/settings
```

**Request Body:** Same structure as GET response

**Response:**
```json
{
  "success": true,
  "message": "Settings saved successfully"
}
```

#### Check Local Solver
```
POST /api/test-astrometry-connection
```

Checks that `solve-field` is installed and counts the available index files (bundled plus `ASTROMETRY_EXTRA_INDEX_DIRS`). No request body and no external service.

**Response:**
```json
{
  "success": true,
  "message": "Local Astrometry.net solver ready (144 index files)"
}
```

### Statistics & Data

#### Get Statistics
```
GET /api/stats
```

**Response:**
```json
{
  "totalImages": 150,
  "plateSolvedImages": 120,
  "totalEquipment": 15,
  "totalIntegrationHours": 45.7,
  "objectTypeCounts": {
    "Galaxy": 45,
    "Nebula": 38,
    "Star Cluster": 25,
    "Planet": 12
  },
  "plateSolvingStats": {
    "total": 125,
    "pending": 5,
    "successful": 120,
    "failed": 0
  }
}
```

#### Get Tags
```
GET /api/tags
```

**Response:**
```json
[
  {
    "tag": "galaxy",
    "count": 45
  },
  {
    "tag": "nebula",
    "count": 38
  },
  {
    "tag": "messier",
    "count": 25
  }
]
```

#### Get Constellations
```
GET /api/constellations
```

**Response:**
```json
[
  "Andromeda",
  "Cassiopeia",
  "Cygnus",
  "Orion",
  "Ursa Major"
]
```

### Notifications

#### Get Notifications
```
GET /api/notifications
```

**Response:**
```json
[
  {
    "id": 1,
    "type": "info",
    "title": "Plate Solving Complete",
    "message": "Successfully plate solved 5 images",
    "details": {
      "imageCount": 5,
      "duration": "2 minutes"
    },
    "acknowledged": false,
    "createdAt": "2023-10-15T22:30:00Z"
  }
]
```

#### Acknowledge Notification
```
POST /api/notifications/{id}/acknowledge
```

**Parameters:**
- `id` (integer) - Notification ID

**Response:**
```json
{
  "success": true,
  "message": "Notification acknowledged"
}
```

### Health & Monitoring

#### Health Check
```
GET /api/health
```

**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2023-10-15T22:30:00Z",
  "uptime": 86400,
  "database": "healthy",
  "worker": {
    "enabled": true,
    "running": true,
    "pid": 1234,
    "restartAttempts": 0
  },
  "version": "1.2.0",
  "nodeVersion": "v20.10.0"
}
```

### Catalog

#### Browse Catalog
```
GET /api/catalog/browse
```

**Query Parameters:**
- `page` (integer) - Page number (default: 1)
- `limit` (integer) - Items per page (default: 50)
- `q` (string) - Search query
- `type` (string) - Filter by object type
- `constellation` (string) - Filter by constellation
- `minMag` / `maxMag` (number) - Magnitude range
- `minSize` (number) - Minimum angular size (arcmin)
- `messierOnly` (boolean) - Show only Messier objects
- `sortBy` (string) - Sort field: `name`, `vMag`, `majorAxis`, `bestNow`
- `sortOrder` (string) - `asc` or `desc`
- `latitude` (number) - Observer latitude for visibility filtering
- `hideBelow` (boolean) - Hide objects below the horizon
- `names` (string) - Comma-separated list of object names

**Response:**
```json
{
  "items": [
    {
      "name": "NGC 224",
      "type": "Galaxy",
      "constellation": "And",
      "raDeg": 10.684,
      "decDeg": 41.269,
      "vMag": 3.44,
      "majorAxis": 190.5
    }
  ],
  "total": 13957,
  "page": 1,
  "limit": 50
}
```

#### Search Catalog (Autocomplete)
```
GET /api/catalog/search
```

**Query Parameters:**
- `q` (string, required) - Search query (min 1 character)

**Response:** Array of matching catalog objects (max 20)

#### Get Catalog Status
```
GET /api/catalog/status
```

**Response:**
```json
{
  "objectCount": 13957,
  "lastUpdated": "2024-01-15T10:00:00Z",
  "commitSha": "abc123"
}
```

#### Get Catalog Object
```
GET /api/catalog/{name}
```

**Parameters:**
- `name` (string) - Object name (URL-encoded, e.g., `NGC%20224`)

**Response:** Single catalog object or `404`

#### Get DSS Thumbnail
```
GET /api/catalog/thumbnail/{name}
```

Fetches a Digitized Sky Survey preview image for the named object. Results are cached on disk; subsequent requests are served as static files.

**Parameters:**
- `name` (string) - Object name (URL-encoded)

**Response:** JPEG image (`image/jpeg`) with a one-year cache header, or `404` if the object has no coordinates.

#### Load/Reload Catalog
```
POST /api/catalog/load
```

Loads or reloads the OpenNGC catalog from GitHub.

**Response:**
```json
{
  "message": "Loaded 13957 catalog objects",
  "count": 13957
}
```

#### Check for Catalog Updates
```
POST /api/catalog/check-updates
```

**Response:** Update availability status

#### Backfill Target Names
```
POST /api/catalog/backfill-targets
```

Re-matches all plate-solved images that have tags but no `targetName` against the catalog.

**Response:**
```json
{
  "message": "Backfill complete: 12 images matched, 45 already had targets",
  "matched": 12,
  "skipped": 45,
  "total": 150
}
```

---

### User Targets

Manage personal annotations (notes, tags) on catalog objects.

#### Get All User Targets
```
GET /api/user-targets
```

**Response:** Array of user target annotations

#### Get Single User Target
```
GET /api/user-targets/{catalogName}
```

**Parameters:**
- `catalogName` (string) - Catalog object name (URL-encoded)

**Response:** User target annotation or `404`

#### Create/Update User Target
```
PUT /api/user-targets/{catalogName}
```

**Parameters:**
- `catalogName` (string) - Catalog object name (URL-encoded)

**Request Body:**
```json
{
  "notes": "Good early autumn target, needs 6+ hours integration",
  "tags": ["wishlist", "autumn"]
}
```

**Response:** Created or updated user target annotation

#### Delete User Target
```
DELETE /api/user-targets/{catalogName}
```

**Response:**
```json
{
  "message": "User target deleted"
}
```

---

### Locations

Manage saved observing sites. Coordinates applied to images are stored in AstroviaBin only.

#### Get All Locations
```
GET /api/locations
```

**Response:** Array of saved locations

#### Get Single Location
```
GET /api/locations/{id}
```

**Parameters:**
- `id` (integer) - Location ID

**Response:** Location object or `404`

#### Create Location
```
POST /api/locations
```

**Request Body:**
```json
{
  "name": "Bortle 3 Site",
  "latitude": 34.05,
  "longitude": -118.25,
  "altitude": 1200
}
```

**Response:** Created location object

#### Update Location
```
PATCH /api/locations/{id}
```

**Request Body:** Partial location fields to update

**Response:** Updated location object or `404`

#### Delete Location
```
DELETE /api/locations/{id}
```

**Response:**
```json
{
  "message": "Location deleted"
}
```

---

### Equipment Groups

Bundle equipment into reusable presets that can be applied to images.

#### Get All Equipment Groups
```
GET /api/equipment-groups
```

**Response:** Array of equipment groups with their members

#### Get Single Equipment Group
```
GET /api/equipment-groups/{id}
```

**Parameters:**
- `id` (integer) - Group ID

**Response:** Equipment group with members or `404`

#### Create Equipment Group
```
POST /api/equipment-groups
```

**Request Body:**
```json
{
  "name": "Widefield Rig",
  "description": "Rokinon 135mm + ASI2600MC",
  "memberIds": [1, 3, 7]
}
```

**Response:** Created group with members

#### Update Equipment Group
```
PUT /api/equipment-groups/{id}
```

**Request Body:**
```json
{
  "name": "Updated Name",
  "description": "Updated description"
}
```

**Response:** Updated group with members or `404`

#### Delete Equipment Group
```
DELETE /api/equipment-groups/{id}
```

**Response:**
```json
{
  "message": "Equipment group deleted successfully"
}
```

#### Replace Group Members
```
PUT /api/equipment-groups/{id}/members
```

**Request Body:**
```json
{
  "memberIds": [1, 3, 7, 12]
}
```

**Response:** Updated group with members

#### Apply Group to Image
```
POST /api/equipment-groups/{id}/apply/{imageId}
```

Assigns all equipment in the group to the specified image.

**Parameters:**
- `id` (integer) - Group ID
- `imageId` (integer) - Image ID

**Response:**
```json
{
  "added": [...],
  "message": "4 equipment item(s) assigned"
}
```

---

### Sky Map

#### Get Sky Map Markers
```
GET /api/sky-map/markers
```

Returns plate-solved images as sky map markers with position and metadata.

**Response:**
```json
[
  {
    "id": 1,
    "title": "M31 Andromeda Galaxy",
    "ra": "0.712",
    "dec": "41.269",
    "thumbnailUrl": "/api/assets/uuid/thumbnail",
    "objectType": "Galaxy",
    "constellation": "Andromeda",
    "fieldOfView": 1.5
  }
]
```

---

### Targets

Aggregate view of imaged targets grouped by object name.

#### List Targets
```
GET /api/targets
```

**Query Parameters:**
- `search` (string) - Filter by target name or common names
- `type` (string) - Filter by object type
- `constellation` (string) - Filter by constellation

**Response:** Array of target summaries (name, image count, total integration time, etc.)

#### Get Single Target
```
GET /api/targets/{name}
```

**Parameters:**
- `name` (string) - Target name (URL-encoded)

**Response:** Target detail with image list or `404`

---

### Database (Admin)

#### Get Database Info
```
GET /api/admin/database
```

**Response:**
```json
{
  "type": "sqlite",
  "path": "/app/config/astroviabin.db",
  "sizeBytes": 1048576,
  "lastModified": "2024-01-15T10:00:00Z"
}
```

#### Download Database Backup
```
GET /api/admin/database/backup
```

Downloads the SQLite database file as an attachment. Only available for SQLite databases; returns `400` for PostgreSQL.

**Response:** Binary SQLite file (`application/x-sqlite3`) with `Content-Disposition` header.

---

### Cron Jobs (Admin)

#### Get Cron Job Status
```
GET /api/admin/cron-jobs
```

Returns the status of all scheduled background jobs (notification cleanup, daily database backup, preview cache cleanup).

**Response:** Array of cron job objects with name, schedule, last run time, and last error.

---

### Users (admin)

- `GET /api/users` — `{ "builtinAdmin": { "username", "role" }, "users": [{ "id", "username", "role", "createdAt", "updatedAt" }] }` (password hashes are never returned).
- `POST /api/users` — `{ "username": "guest", "password": "at-least-8", "role": "viewer" }` → `201`. `409` if the name is taken (including the built-in admin).
- `PATCH /api/users/{id}` — `{ "role": "editor" }` and/or `{ "password": "..." }`. A password change signs that account out.
- `DELETE /api/users/{id}` → `204`.

### Gallery catalogs

Named groups of photos and FITS frames.

- `GET /api/gallery-catalogs` — list with `imageCount` and `coverImageId`.
- `POST /api/gallery-catalogs` — `{ "name": "Messier marathon", "description": "optional" }` → `201` (`409` on a duplicate name, case-insensitive).
- `PATCH /api/gallery-catalogs/{id}` — rename or change the description.
- `DELETE /api/gallery-catalogs/{id}` — removes the catalog only; images stay.
- `POST /api/gallery-catalogs/{id}/images` — `{ "imageIds": [1, 2, 3] }` → `{ "added": 3 }` (already present images are skipped).
- `DELETE /api/gallery-catalogs/{id}/images/{imageId}`
- `GET /api/images?galleryCatalogId={id}` — gallery filtered by catalog; `GET /api/images/{id}/gallery-catalogs` — catalog ids for one image.

## Error Handling

The API uses standard HTTP status codes:

- `200` - Success
- `400` - Bad Request (missing or invalid parameters)
- `404` - Not Found (resource doesn't exist)
- `500` - Internal Server Error

All error responses include a descriptive message:

```json
{
  "message": "Image not found",
  "error": "Additional error details"
}
```

## Rate Limiting

Currently, there are no rate limits implemented. However, be mindful of:
- Bulk operations (like plate solving) can be resource-intensive
- HOTPANTS runs are limited to two at a time to control memory use
- Automatic SkyView reference lookup sends sky coordinates and field size only

## Private FITS difference analysis

These endpoints operate on a FITS already stored in AstroviaBin. Science FITS
files stay local and are not sent to Astrometry.net or Photutils servers.
A survey reference request sends sky coordinates and field size only; use
a local FITS reference to avoid that external request.

### Start and list analyses

```http
GET  /api/fits/:imageId/analyses
POST /api/fits/:imageId/analyses
```

The POST body accepts `referenceMode` (`survey` or `local`),
`referenceImageId`, `survey`, `maxDimension`, `thresholdSigma`,
`sourceFwhm`, `maxCandidates`, and guarded `hotpantsOptions`.
Poll the saved report while `status` is `running`.

### Read, download, or delete a saved report

```http
GET    /api/fits/:imageId/analyses/:runId
GET    /api/fits/:imageId/analyses/:runId/files/:filename
DELETE /api/fits/:imageId/analyses/:runId
```

Deleting removes that run's generated report and FITS outputs. It does not
remove the original image or other reports. A running report returns
`409` and cannot be deleted.

### Check a candidate in a second local exposure

```http
POST /api/fits/:imageId/analyses/:runId/candidates/:candidateIndex/check
Content-Type: application/json

{ "followupImageId": 52 }
```

The follow-up is solved locally if needed. A repeat detection is reported
only when a point source is present at the saved sky coordinate, the
filter matches, and the observation date differs. This is supporting
evidence, not an automatic discovery confirmation.

Auxiliary files and HOTPANTS utilities are also available under
`/api/fits/:imageId/analysis-inputs` and
`/api/fits/:imageId/analyses/:runId/utilities`. See
[`docs/hotpants.md`](hotpants.md) for scientific limitations and privacy.

## WebSocket Events

AstroviaBin uses native WebSocket for real-time updates. Connect to `ws://<host>/ws` with a signed-in session cookie and listen for JSON messages:

### Plate Solving Updates
```javascript
const ws = new WebSocket(`ws://${location.host}/ws`);
ws.onmessage = (event) => {
  const { event: type, data } = JSON.parse(event.data);
  if (type === 'plate-solving-update') {
    console.log('Plate solving update:', data);
    // data: { jobId, status ('pending' | 'processing' | 'success' | 'failed'), result, imageId, message }
  }
};
```

## SDK Usage

For TypeScript/JavaScript applications, you can use the API with fetch:

```javascript
// Get all images
const response = await fetch('/api/images');
const images = await response.json();

// Submit for plate solving
const result = await fetch(`/api/images/${imageId}/plate-solve`, {
  method: 'POST'
});
const plateSolveResult = await result.json();
```

## Environment Variables

Some API behavior can be configured via environment variables (legacy `SIDEREAL_*` names are accepted as aliases):

- `ASTROVIABIN_ADMIN_USER` / `ASTROVIABIN_ADMIN_PASSWORD` - Built-in administrator (default `admin` / `admin`)
- `ASTROVIABIN_SESSION_SECRET` - Session signing key (generated and stored next to the database when unset)
- `ENABLE_PLATE_SOLVING` - Enable/disable plate solving worker
- `ASTROMETRY_EXTRA_INDEX_DIRS` - Extra Astrometry.net index directories for narrow fields
- `FITS_ANALYSIS_DIR` - Persistent location for private analysis reports and intermediate FITS layers

Note: Admin settings take precedence over environment variables.

## Best Practices

1. **Use filtering** - Always filter API responses when possible to reduce payload size
2. **Handle errors** - Implement proper error handling for all API calls
3. **Check health** - Monitor the `/api/health` endpoint for system status
4. **Batch operations** - Use bulk endpoints when processing multiple items
5. **Real-time updates** - Use WebSocket connections for live updates
6. **Asset caching** - Cache image assets appropriately to reduce load

## Support

For API support and questions:
- Check the [GitHub Issues](https://github.com/kroryan/AstroviaBIn/issues)
- Review the [Contributing Guide](../CONTRIBUTING.md)
