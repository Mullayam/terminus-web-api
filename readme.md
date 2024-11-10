
# Terminal Collaboration Platform - Backend

A secure, real-time terminal collaboration platform enabling shared SFTP sessions, multi-user terminal access, and AI-assisted development.

![Build Status](https://img.shields.io/badge/build-passing-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)
![Version](https://img.shields.io/badge/version-1.0.0-orange)

## 🚀 Features

- **Live Terminal Sharing**
  - Real-time terminal session collaboration
  - Multiple user support with concurrent access
  - Role-based permissions (read/write/admin)
  - Session recording and playback

- **Secure SFTP Integration**
  - Web-based SFTP client
  - File system operations with live updates
  - Multi-user file access control
  - Transfer progress monitoring

- **AI Development Assistant**
  - Context-aware code suggestions
  - Command history analysis
  - Error detection and resolution
  - Best practices recommendations

- **Key Vault Management**
  - Secure credential storage
  - SSH key management
  - Access token handling
  - Encryption at rest

## 🛠 Technology Stack

- **Core:**
  - Node.js / Express.js
  - WebSocket (Socket.io)
  - Redis for session management

- **Security:**
  - JWT authentication
  - SSH key encryption
  - HTTPS/WSS protocols
  - Rate limiting

- **Terminal:**
  - PTY.js for terminal emulation
  - SSH2 for SFTP operations
  - xterm.js compatibility

## 📋 Prerequisites

```bash
Node.js >= 18.x
Redis >= 6.x
Python >= 3.8 (for AI components)
```

## 🔧 Installation

1. Clone the repository:
```bash
git clone https://github.com/Mullayam/terminus-web
cd terminus-web
```

2. Install dependencies:
```bash
npm install
```

3. Set up environment variables:
```bash
cp .env.example .env
# Edit .env with your configuration
```

4. Start the server:
```bash
npm run dev     # Development
npm run start   # Production
```

## ⚙️ Configuration

The platform can be configured through environment variables:

```env
# Server Configuration
PORT=7145
NODE_ENV=development

# Database
REDIS_URL=""

# Security
JWT_SECRET=your_jwt_secret
ENCRYPTION_KEY=your_encryption_key
FRONTEND_URL=http://localhost:5173
```

## 🔐 Security Considerations

- All sessions are encrypted end-to-end
- Credentials are never stored in plaintext
- Regular security audits are performed
- Rate limiting prevents abuse
- Session timeouts are enforced
- Access logs are maintained

## 🌐 API Documentation

### Authentication

```bash
POST /api/auth/login
POST /api/auth/register
POST /api/auth/refresh
```

### Terminal Sessions

```bash
POST /api/sessions/create
GET /api/sessions/:id
PUT /api/sessions/:id/permissions
DELETE /api/sessions/:id
```

### SFTP Operations

```bash
POST /api/sftp/upload
GET /api/sftp/download 
```

### Key Management

```bash
POST /api/keys/create
GET /api/keys/list
PUT /api/keys/update
DELETE /api/keys/delete
```

## 📊 Monitoring

The platform includes built-in monitoring endpoints:

- `/health` - Service health check
- `/metrics` - Prometheus-compatible metrics
- `/status` - System status dashboard


## 🤝 Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## 📝 License

This project is licensed under the MIT License - see the [LICENSE.md](LICENSE.md) file for details.

## 👥 Authors

-  [Mullayam ](https://github.com/Mullayam/terminus-web)- *Initial work* 
-  [Kunal](https://github.com/Mullayam/terminus-web)- *Collaborator-Frontend*  
- [Shubham Singh](https://github.com/shubhexists) -   *Collaborator-Full Stack*  

## 🙏 Acknowledgments

- PTY.js team for terminal emulation
- Socket.io team for real-time capabilities
- OpenAI for AI integration support

## 📞 Support

For support, email mullayam@enjoys.in 