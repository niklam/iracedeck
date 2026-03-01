# Security Policy

## Supported Versions

Only the latest release receives security fixes. There is no backporting to older versions.

## Reporting a Vulnerability

**Do not open a public issue for security vulnerabilities.**

Please report vulnerabilities through [GitHub's private vulnerability reporting](https://github.com/niklam/iracedeck/security/advisories/new). You'll receive an acknowledgment within 48 hours and a follow-up with next steps within a week.

## Scope

This project is a locally-running Stream Deck plugin. The security surface is small, but reports are welcome for:

- Vulnerabilities in the native C++ addon (memory safety, buffer overflows)
- Dependency supply chain issues
- Anything that could allow unintended code execution beyond keyboard simulation
- Path traversal or file access issues

## Out of Scope

- Bugs in iRacing itself
- Bugs in the Elgato Stream Deck software
- Social engineering
- Denial of service against local resources (the plugin already runs locally with full user permissions)
