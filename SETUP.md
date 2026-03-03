# Database Setup Instructions

## MySQL Database Connection

Your database credentials have been configured. Here's how to set up the connection:

### Step 1: Create .env file

Create a `.env` file in the `MarryBackend` directory with the following content:

```env
# Server Configuration
PORT=5001
NODE_ENV=development

# MySQL Database Configuration
DB_NAME=u214419219_matkafun
DB_USER=u214419219_matkafun
DB_PASSWORD=Marrytube@123!
DB_HOST=145.79.209.227
DB_PORT=3306

# JWT Secret
JWT_SECRET=marrytube-secret-key-change-in-production-2024

# AWS S3 Configuration (Update with your credentials)
AWS_ACCESS_KEY_ID=your-aws-access-key
AWS_SECRET_ACCESS_KEY=your-aws-secret-key
AWS_REGION=us-east-1
S3_BUCKET_NAME=marrytube-media

# Twilio Configuration (Optional - for SMS OTP)
TWILIO_ACCOUNT_SID=your-twilio-account-sid
TWILIO_AUTH_TOKEN=your-twilio-auth-token
TWILIO_PHONE_NUMBER=+1234567890

# Email Configuration (Optional - for Email OTP)
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_USER=your-email@gmail.com
EMAIL_PASS=your-email-password

# OTP Configuration
OTP_EXPIRY_MINUTES=10
OTP_LENGTH=6
```

### Database Details

- **Database Name:** u214419219_matkafun
- **Username:** u214419219_matkafun
- **Password:** Marrytube@123!
- **Host:** 145.79.209.227
- **Port:** 3306 (default MySQL port)

### Important Notes

1. **Database Type:** This project uses MySQL (not MongoDB). Make sure your hosting provider supports MySQL.

2. **Port:** If port 3306 doesn't work, your hosting provider might use a different port. Check with them and update the `DB_PORT` in your `.env` file.

3. **Connection:** The connection is handled automatically by Sequelize ORM using the environment variables.

### Testing the Connection

After creating the `.env` file, start the server:

```bash
npm start
```

You should see:
```
MySQL connected successfully
Server is running on port 5001
```

If you see a connection error, check:
- The MySQL service is running on your hosting
- The port number is correct (usually 3306)
- The username and password are correct
- Your IP address is whitelisted (if required by your hosting provider)
- The database exists and the user has proper permissions

### Alternative Port (if default port doesn't work)

If port 3306 doesn't work, update the `DB_PORT` in your `.env` file:

```env
DB_PORT=3307
# or
DB_PORT=3308
```

Or check your hosting control panel for the correct MySQL port.

