# MarryBackend - Node.js Backend API

Backend API server for MarryTube media storage application built with Node.js, Express, and MongoDB.

## Features

- **Authentication**
  - OTP-based authentication (Email/SMS) for customers
  - Email/Password authentication for Admin and Studio users
  - JWT token-based session management

- **Media Management**
  - Upload media files to AWS S3
  - Organize media in folders
  - View, delete media
  - Support for images, videos, documents

- **Storage Management**
  - Storage plans (monthly/yearly)
  - Track storage usage
  - Purchase additional storage

- **Admin Features**
  - User management
  - Media management and moderation
  - Storage plan management
  - View all users and their storage usage

- **Studio Features**
  - Client management
  - Upload media for clients
  - Purchase storage for clients
  - Fund request management
  - Dashboard with statistics

## Prerequisites

- Node.js (v14 or higher)
- MongoDB (local or cloud instance)
- AWS S3 account (for file storage)
- Twilio account (optional, for SMS OTP)
- Email service (optional, for Email OTP)

## Installation

1. Clone the repository and navigate to the MarryBackend folder:
```bash
cd MarryBackend
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file in the root directory and add the following configuration:

```env
# Server Configuration
PORT=5001
NODE_ENV=development

# MongoDB Configuration
# Database credentials:
# Database: a1770cc9_marrytube
# Username: a1770cc9_marrytube
# Password: Shree@123! (URL encoded as Shree%40123%21)
# Host: 162.241.27.225
MONGODB_URI=mongodb://a1770cc9_marrytube:Shree%40123%21@162.241.27.225:27017/a1770cc9_marrytube

# JWT Secret (Change this to a secure random string in production)
JWT_SECRET=marrytube-secret-key-change-in-production-2024

# AWS S3 Configuration (Update with your AWS credentials)
AWS_ACCESS_KEY_ID=your-aws-access-key
AWS_SECRET_ACCESS_KEY=your-aws-secret-key
AWS_REGION=us-east-1
S3_BUCKET_NAME=marrytube-media

# Twilio Configuration (for SMS OTP - Optional)
TWILIO_ACCOUNT_SID=your-twilio-account-sid
TWILIO_AUTH_TOKEN=your-twilio-auth-token
TWILIO_PHONE_NUMBER=+1234567890

# Email Configuration (for Email OTP - Optional)
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_USER=your-email@gmail.com
EMAIL_PASS=your-email-password

# OTP Configuration
OTP_EXPIRY_MINUTES=10
OTP_LENGTH=6
```

**Note:** If port 27017 doesn't work, check with your hosting provider for the correct MongoDB port and update the MONGODB_URI accordingly.

## Configuration

### Environment Variables

- `PORT`: Server port (default: 5001)
- `MONGODB_URI`: MongoDB connection string
- `JWT_SECRET`: Secret key for JWT tokens
- `AWS_ACCESS_KEY_ID`: AWS access key
- `AWS_SECRET_ACCESS_KEY`: AWS secret key
- `AWS_REGION`: AWS region
- `S3_BUCKET_NAME`: S3 bucket name
- `TWILIO_ACCOUNT_SID`: Twilio account SID (optional)
- `TWILIO_AUTH_TOKEN`: Twilio auth token (optional)
- `TWILIO_PHONE_NUMBER`: Twilio phone number (optional)
- `EMAIL_HOST`: SMTP host (optional)
- `EMAIL_PORT`: SMTP port (optional)
- `EMAIL_USER`: Email username (optional)
- `EMAIL_PASS`: Email password (optional)
- `OTP_EXPIRY_MINUTES`: OTP expiry time in minutes (default: 10)
- `OTP_LENGTH`: OTP length (default: 6)

## Running the Server

### Development Mode
```bash
npm run dev
```

### Production Mode
```bash
npm start
```

The server will start on `http://localhost:5001` (or the port specified in `.env`).

## API Endpoints

### Authentication
- `POST /api/auth/send-otp` - Send OTP
- `POST /api/auth/verify-otp` - Verify OTP and login/register
- `POST /api/auth/studio/login` - Studio login
- `POST /api/auth/admin/login` - Admin login
- `POST /api/auth/change-phone` - Change phone number
- `GET /api/auth/me` - Get current user

### Media
- `GET /api/media/list` - Get media list
- `GET /api/media/:mediaId` - Get media by ID
- `POST /api/media/upload-url` - Get presigned upload URL
- `POST /api/media/save` - Save media after upload
- `DELETE /api/media/:mediaId` - Delete media
- `GET /api/media/folders/list` - Get folders
- `POST /api/media/folders` - Create folder
- `DELETE /api/media/folders/:folderId` - Delete folder

### Storage
- `GET /api/storage/plans` - Get storage plans
- `GET /api/storage/user` - Get user storage
- `POST /api/storage/purchase` - Purchase storage

### Admin
- `GET /api/admin/users` - Get all users
- `GET /api/admin/media` - Get all media
- `DELETE /api/admin/media/:mediaId` - Delete media
- `PATCH /api/admin/media/:mediaId/block` - Block/unblock media
- `GET /api/admin/storage` - Get all storage usage
- `GET /api/admin/plans` - Get storage plans
- `POST /api/admin/plans` - Create/Update storage plan
- `DELETE /api/admin/plans/:planId` - Delete storage plan

### Studio
- `GET /api/studio/dashboard` - Get studio dashboard
- `GET /api/studio/clients` - Get studio clients
- `POST /api/studio/clients` - Add studio client
- `PATCH /api/studio/clients/:clientId` - Update studio client
- `DELETE /api/studio/clients/:clientId` - Delete studio client
- `GET /api/studio/clients/:clientId/details` - Get client details
- `POST /api/studio/clients/:clientId/purchase-space` - Purchase space for client
- `POST /api/studio/clients/:clientId/upload-url` - Get upload URL for client
- `POST /api/studio/clients/:clientId/media` - Save media for client
- `GET /api/studio/fund-requests` - Get fund requests
- `POST /api/studio/fund-requests` - Create fund request

## Authentication

Most endpoints require authentication. Include the JWT token in the Authorization header:
```
Authorization: Bearer <your-token>
```

## Database Models

- **User**: User accounts (customer, admin, studio)
- **Media**: Media files metadata
- **Folder**: User folders for organizing media
- **Storage**: User storage information
- **StoragePlan**: Available storage plans
- **OTP**: OTP records for verification
- **StudioClient**: Studio-client relationships
- **FundRequest**: Studio fund withdrawal requests

## Project Structure

```
MarryBackend/
├── models/          # MongoDB models
├── routes/          # API routes
├── middleware/      # Express middleware
├── services/        # Business logic services
├── server.js        # Main server file
├── package.json     # Dependencies
└── .env            # Environment variables
```

## Notes

- OTP service works in mock mode if Twilio/Email is not configured (logs OTP to console)
- S3 integration requires valid AWS credentials
- All file sizes are tracked in bytes, storage is managed in GB
- Storage usage is automatically updated when media is uploaded/deleted

## License

ISC

