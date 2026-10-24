// Exact local copy of the versioned wire catalog; equality is tested.
export const schema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:financial-brain:qbo-broker:1:schemas",
  "title": "QuickBooks broker protocol version 1",
  "description": "Review-only wire and custody schemas. This catalog is not a deployable broker. Each named $defs entry is independently addressable. Schema validity does not prove signatures, semantic bindings, TLS, DNS, storage transactions, retention, or provider behavior.",
  "$defs": {
    "protocol": {
      "const": "qbo-broker/1"
    },
    "capability": {
      "type": "string",
      "minLength": 43,
      "maxLength": 128,
      "pattern": "^[A-Za-z0-9_-]{43,128}$"
    },
    "digest": {
      "type": "string",
      "minLength": 43,
      "maxLength": 43,
      "pattern": "^[A-Za-z0-9_-]{43}$"
    },
    "signature": {
      "type": "string",
      "minLength": 86,
      "maxLength": 86,
      "pattern": "^[A-Za-z0-9_-]{86}$"
    },
    "timestamp": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "generation": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "environment": {
      "type": "string",
      "enum": [
        "sandbox",
        "production"
      ]
    },
    "callback": {
      "type": "string",
      "minLength": 1,
      "maxLength": 512,
      "pattern": "^https://[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?/api/quickbooks/connect/callback$"
    },
    "publicKey": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "kty": {
          "const": "EC"
        },
        "crv": {
          "const": "P-256"
        },
        "x": {
          "$ref": "#/$defs/digest"
        },
        "y": {
          "$ref": "#/$defs/digest"
        }
      },
      "required": [
        "kty",
        "crv",
        "x",
        "y"
      ]
    },
    "storedCiphertext": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "ciphertext": {
          "type": "string",
          "minLength": 22,
          "maxLength": 40000,
          "pattern": "^[A-Za-z0-9_-]+$",
          "x-private": true
        },
        "iv": {
          "type": "string",
          "minLength": 16,
          "maxLength": 16,
          "pattern": "^[A-Za-z0-9_-]{16}$"
        },
        "authentication_tag": {
          "type": "string",
          "minLength": 22,
          "maxLength": 22,
          "pattern": "^[A-Za-z0-9_-]{22}$"
        },
        "key_version": {
          "$ref": "#/$defs/generation"
        },
        "aad_hash": {
          "$ref": "#/$defs/digest"
        }
      },
      "required": [
        "ciphertext",
        "iv",
        "authentication_tag",
        "key_version",
        "aad_hash"
      ]
    },
    "enrollmentChallenge": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "protocol": {
          "$ref": "#/$defs/protocol"
        },
        "challenge": {
          "$ref": "#/$defs/capability",
          "x-private": true
        },
        "callback": {
          "$ref": "#/$defs/callback"
        },
        "install_public_key": {
          "$ref": "#/$defs/publicKey"
        },
        "environment": {
          "$ref": "#/$defs/environment"
        },
        "key_generation": {
          "$ref": "#/$defs/generation"
        },
        "issued_at": {
          "$ref": "#/$defs/timestamp"
        },
        "expires_at": {
          "$ref": "#/$defs/timestamp"
        },
        "signature": {
          "$ref": "#/$defs/signature"
        }
      },
      "required": [
        "protocol",
        "challenge",
        "callback",
        "install_public_key",
        "environment",
        "key_generation",
        "issued_at",
        "expires_at",
        "signature"
      ]
    },
    "enrollmentIssue": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "protocol": {
          "$ref": "#/$defs/protocol"
        },
        "request_id": {
          "$ref": "#/$defs/capability"
        },
        "challenge": {
          "$ref": "#/$defs/capability",
          "x-private": true
        },
        "callback": {
          "$ref": "#/$defs/callback"
        },
        "install_public_key": {
          "$ref": "#/$defs/publicKey"
        },
        "environment": {
          "$ref": "#/$defs/environment"
        },
        "issued_at": {
          "$ref": "#/$defs/timestamp"
        },
        "expires_at": {
          "$ref": "#/$defs/timestamp"
        }
      },
      "required": [
        "protocol",
        "request_id",
        "challenge",
        "callback",
        "install_public_key",
        "environment",
        "issued_at",
        "expires_at"
      ]
    },
    "voucherClaims": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "protocol": {
          "$ref": "#/$defs/protocol"
        },
        "environment": {
          "$ref": "#/$defs/environment"
        },
        "key_generation": {
          "$ref": "#/$defs/generation"
        },
        "voucher_id": {
          "$ref": "#/$defs/capability"
        },
        "issued_at": {
          "$ref": "#/$defs/timestamp"
        },
        "expires_at": {
          "$ref": "#/$defs/timestamp"
        },
        "callback": {
          "$ref": "#/$defs/callback"
        },
        "install_public_key": {
          "$ref": "#/$defs/publicKey"
        }
      },
      "required": [
        "protocol",
        "environment",
        "key_generation",
        "voucher_id",
        "issued_at",
        "expires_at",
        "callback",
        "install_public_key"
      ]
    },
    "installationVoucher": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "claims": {
          "$ref": "#/$defs/voucherClaims"
        },
        "mac": {
          "$ref": "#/$defs/digest"
        }
      },
      "required": [
        "claims",
        "mac"
      ]
    },
    "enrollmentDelivery": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "protocol": {
          "$ref": "#/$defs/protocol"
        },
        "challenge": {
          "$ref": "#/$defs/capability",
          "x-private": true
        },
        "voucher": {
          "$ref": "#/$defs/installationVoucher"
        }
      },
      "required": [
        "protocol",
        "challenge",
        "voucher"
      ]
    },
    "ownerInstallation": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "protocol": {
          "$ref": "#/$defs/protocol"
        },
        "voucher": {
          "$ref": "#/$defs/storedCiphertext"
        },
        "install_private_key": {
          "$ref": "#/$defs/storedCiphertext"
        },
        "install_fingerprint": {
          "$ref": "#/$defs/digest"
        },
        "key_generation": {
          "$ref": "#/$defs/generation"
        },
        "expires_at": {
          "$ref": "#/$defs/timestamp"
        }
      },
      "required": [
        "protocol",
        "voucher",
        "install_private_key",
        "install_fingerprint",
        "key_generation",
        "expires_at"
      ]
    },
    "startBody": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "intent": {
          "$ref": "#/$defs/capability"
        },
        "callback": {
          "$ref": "#/$defs/callback"
        },
        "environment": {
          "$ref": "#/$defs/environment"
        },
        "delivery_public_key": {
          "$ref": "#/$defs/publicKey"
        },
        "delivery_auth_key": {
          "$ref": "#/$defs/digest",
          "x-private": true
        },
        "expected_token_generation": {
          "$ref": "#/$defs/generation"
        }
      },
      "required": [
        "intent",
        "callback",
        "environment",
        "delivery_public_key",
        "delivery_auth_key",
        "expected_token_generation"
      ]
    },
    "refreshBody": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "intent": {
          "$ref": "#/$defs/capability"
        },
        "callback": {
          "$ref": "#/$defs/callback"
        },
        "environment": {
          "$ref": "#/$defs/environment"
        },
        "delivery_public_key": {
          "$ref": "#/$defs/publicKey"
        },
        "token_generation": {
          "$ref": "#/$defs/generation"
        },
        "company_fingerprint": {
          "$ref": "#/$defs/companyFingerprint"
        },
        "refresh_token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 4096,
          "x-private": true
        },
        "realm_id": {
          "$ref": "#/$defs/realmId"
        },
        "delivery_auth_key": {
          "$ref": "#/$defs/digest",
          "x-private": true
        }
      },
      "required": [
        "intent",
        "callback",
        "environment",
        "delivery_public_key",
        "token_generation",
        "company_fingerprint",
        "refresh_token",
        "realm_id",
        "delivery_auth_key"
      ]
    },
    "noContactClaims": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "protocol": {
          "$ref": "#/$defs/protocol"
        },
        "request_id": {
          "$ref": "#/$defs/capability"
        },
        "install_fingerprint": {
          "$ref": "#/$defs/digest"
        },
        "intent": {
          "$ref": "#/$defs/capability"
        },
        "token_generation": {
          "$ref": "#/$defs/generation"
        },
        "key_generation": {
          "$ref": "#/$defs/generation"
        },
        "expires_at": {
          "$ref": "#/$defs/timestamp"
        },
        "provider_contact": {
          "const": "not_sent"
        },
        "operation_hash": {
          "$ref": "#/$defs/digest"
        }
      },
      "required": [
        "protocol",
        "request_id",
        "install_fingerprint",
        "intent",
        "token_generation",
        "key_generation",
        "expires_at",
        "provider_contact",
        "operation_hash"
      ]
    },
    "noContactProof": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "claims": {
          "$ref": "#/$defs/noContactClaims"
        },
        "mac": {
          "$ref": "#/$defs/digest"
        }
      },
      "required": [
        "claims",
        "mac"
      ]
    },
    "revokeBody": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "intent": {
          "$ref": "#/$defs/capability"
        },
        "callback": {
          "$ref": "#/$defs/callback"
        },
        "environment": {
          "$ref": "#/$defs/environment"
        },
        "token_generation": {
          "$ref": "#/$defs/generation"
        },
        "token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 4096,
          "x-private": true
        },
        "token_type": {
          "type": "string",
          "enum": [
            "refresh_token",
            "access_token"
          ]
        },
        "no_contact_proof": {
          "$ref": "#/$defs/noContactProof"
        }
      },
      "required": [
        "intent",
        "callback",
        "environment",
        "token_generation",
        "token",
        "token_type"
      ]
    },
    "startRequest": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "protocol": {
          "$ref": "#/$defs/protocol"
        },
        "method": {
          "const": "POST"
        },
        "route": {
          "const": "/v1/quickbooks/authorizations"
        },
        "request_id": {
          "$ref": "#/$defs/capability"
        },
        "issued_at": {
          "$ref": "#/$defs/timestamp"
        },
        "expires_at": {
          "$ref": "#/$defs/timestamp"
        },
        "key_generation": {
          "$ref": "#/$defs/generation"
        },
        "voucher": {
          "$ref": "#/$defs/installationVoucher"
        },
        "body": {
          "$ref": "#/$defs/startBody"
        },
        "body_hash": {
          "$ref": "#/$defs/digest"
        },
        "signature": {
          "$ref": "#/$defs/signature"
        }
      },
      "required": [
        "protocol",
        "method",
        "route",
        "request_id",
        "issued_at",
        "expires_at",
        "key_generation",
        "voucher",
        "body",
        "body_hash",
        "signature"
      ]
    },
    "refreshRequest": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "protocol": {
          "$ref": "#/$defs/protocol"
        },
        "method": {
          "const": "POST"
        },
        "route": {
          "const": "/v1/quickbooks/tokens/refresh"
        },
        "request_id": {
          "$ref": "#/$defs/capability"
        },
        "issued_at": {
          "$ref": "#/$defs/timestamp"
        },
        "expires_at": {
          "$ref": "#/$defs/timestamp"
        },
        "key_generation": {
          "$ref": "#/$defs/generation"
        },
        "voucher": {
          "$ref": "#/$defs/installationVoucher"
        },
        "body": {
          "$ref": "#/$defs/refreshBody"
        },
        "body_hash": {
          "$ref": "#/$defs/digest"
        },
        "signature": {
          "$ref": "#/$defs/signature"
        }
      },
      "required": [
        "protocol",
        "method",
        "route",
        "request_id",
        "issued_at",
        "expires_at",
        "key_generation",
        "voucher",
        "body",
        "body_hash",
        "signature"
      ]
    },
    "revokeRequest": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "protocol": {
          "$ref": "#/$defs/protocol"
        },
        "method": {
          "const": "POST"
        },
        "route": {
          "const": "/v1/quickbooks/tokens/revoke"
        },
        "request_id": {
          "$ref": "#/$defs/capability"
        },
        "issued_at": {
          "$ref": "#/$defs/timestamp"
        },
        "expires_at": {
          "$ref": "#/$defs/timestamp"
        },
        "key_generation": {
          "$ref": "#/$defs/generation"
        },
        "voucher": {
          "$ref": "#/$defs/installationVoucher"
        },
        "body": {
          "$ref": "#/$defs/revokeBody"
        },
        "body_hash": {
          "$ref": "#/$defs/digest"
        },
        "signature": {
          "$ref": "#/$defs/signature"
        }
      },
      "required": [
        "protocol",
        "method",
        "route",
        "request_id",
        "issued_at",
        "expires_at",
        "key_generation",
        "voucher",
        "body",
        "body_hash",
        "signature"
      ]
    },
    "launchRequest": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "protocol": {
          "$ref": "#/$defs/protocol"
        },
        "launch_capability": {
          "$ref": "#/$defs/capability",
          "x-private": true
        },
        "transaction": {
          "$ref": "#/$defs/transactionCapsule"
        }
      },
      "required": [
        "protocol",
        "launch_capability",
        "transaction"
      ],
      "description": "Logical decoded launch body. On the wire use a top-level application/x-www-form-urlencoded POST with exactly protocol, launch_capability, and transaction; transaction is a canonical JSON string that is decoded before validating this shape."
    },
    "launchResponse": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "protocol": {
          "$ref": "#/$defs/protocol"
        },
        "launch_capability": {
          "$ref": "#/$defs/capability",
          "x-private": true
        },
        "expires_at": {
          "$ref": "#/$defs/timestamp"
        },
        "transaction": {
          "$ref": "#/$defs/transactionCapsule"
        }
      },
      "required": [
        "protocol",
        "launch_capability",
        "expires_at",
        "transaction"
      ]
    },
    "callbackSuccess": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "state": {
          "$ref": "#/$defs/capability",
          "x-private": true
        },
        "code": {
          "type": "string",
          "minLength": 1,
          "maxLength": 4096,
          "x-private": true
        },
        "realmId": {
          "$ref": "#/$defs/realmId"
        }
      },
      "required": [
        "state",
        "code",
        "realmId"
      ]
    },
    "callbackDenied": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "state": {
          "$ref": "#/$defs/capability",
          "x-private": true
        },
        "error": {
          "const": "access_denied"
        }
      },
      "required": [
        "state",
        "error"
      ]
    },
    "callbackQuery": {
      "oneOf": [
        {
          "$ref": "#/$defs/callbackSuccess"
        },
        {
          "$ref": "#/$defs/callbackDenied"
        }
      ]
    },
    "deliveryHeader": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "protocol": {
          "$ref": "#/$defs/protocol"
        },
        "purpose": {
          "const": "connect"
        },
        "delivery_id": {
          "$ref": "#/$defs/capability"
        },
        "request_id": {
          "$ref": "#/$defs/capability"
        },
        "install_fingerprint": {
          "$ref": "#/$defs/digest"
        },
        "intent": {
          "$ref": "#/$defs/capability"
        },
        "callback": {
          "$ref": "#/$defs/callback"
        },
        "environment": {
          "$ref": "#/$defs/environment"
        },
        "key_generation": {
          "$ref": "#/$defs/generation"
        },
        "delivery_key_fingerprint": {
          "$ref": "#/$defs/digest"
        },
        "token_generation": {
          "$ref": "#/$defs/generation"
        },
        "expires_at": {
          "$ref": "#/$defs/timestamp"
        }
      },
      "required": [
        "protocol",
        "purpose",
        "delivery_id",
        "request_id",
        "install_fingerprint",
        "intent",
        "callback",
        "environment",
        "key_generation",
        "delivery_key_fingerprint",
        "token_generation",
        "expires_at"
      ]
    },
    "refreshHeader": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "protocol": {
          "$ref": "#/$defs/protocol"
        },
        "purpose": {
          "const": "refresh"
        },
        "delivery_id": {
          "$ref": "#/$defs/capability"
        },
        "request_id": {
          "$ref": "#/$defs/capability"
        },
        "install_fingerprint": {
          "$ref": "#/$defs/digest"
        },
        "intent": {
          "$ref": "#/$defs/capability"
        },
        "callback": {
          "$ref": "#/$defs/callback"
        },
        "environment": {
          "$ref": "#/$defs/environment"
        },
        "key_generation": {
          "$ref": "#/$defs/generation"
        },
        "delivery_key_fingerprint": {
          "$ref": "#/$defs/digest"
        },
        "token_generation": {
          "$ref": "#/$defs/generation"
        },
        "expires_at": {
          "$ref": "#/$defs/timestamp"
        }
      },
      "required": [
        "protocol",
        "purpose",
        "delivery_id",
        "request_id",
        "install_fingerprint",
        "intent",
        "callback",
        "environment",
        "key_generation",
        "delivery_key_fingerprint",
        "token_generation",
        "expires_at"
      ]
    },
    "deliveryEnvelope": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "header": {
          "$ref": "#/$defs/deliveryHeader"
        },
        "ephemeral_public_key": {
          "$ref": "#/$defs/publicKey"
        },
        "salt": {
          "$ref": "#/$defs/digest"
        },
        "iv": {
          "type": "string",
          "minLength": 16,
          "maxLength": 16,
          "pattern": "^[A-Za-z0-9_-]{16}$"
        },
        "ciphertext": {
          "type": "string",
          "minLength": 22,
          "maxLength": 40000,
          "pattern": "^[A-Za-z0-9_-]+$",
          "x-private": true
        },
        "authentication_tag": {
          "type": "string",
          "minLength": 22,
          "maxLength": 22,
          "pattern": "^[A-Za-z0-9_-]{22}$"
        },
        "broker_authentication_tag": {
          "$ref": "#/$defs/digest"
        }
      },
      "required": [
        "header",
        "ephemeral_public_key",
        "salt",
        "iv",
        "ciphertext",
        "authentication_tag",
        "broker_authentication_tag"
      ]
    },
    "refreshResponse": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "header": {
          "$ref": "#/$defs/refreshHeader"
        },
        "ephemeral_public_key": {
          "$ref": "#/$defs/publicKey"
        },
        "salt": {
          "$ref": "#/$defs/digest"
        },
        "iv": {
          "type": "string",
          "minLength": 16,
          "maxLength": 16,
          "pattern": "^[A-Za-z0-9_-]{16}$"
        },
        "ciphertext": {
          "type": "string",
          "minLength": 22,
          "maxLength": 40000,
          "pattern": "^[A-Za-z0-9_-]+$",
          "x-private": true
        },
        "authentication_tag": {
          "type": "string",
          "minLength": 22,
          "maxLength": 22,
          "pattern": "^[A-Za-z0-9_-]{22}$"
        },
        "broker_authentication_tag": {
          "$ref": "#/$defs/digest"
        }
      },
      "required": [
        "header",
        "ephemeral_public_key",
        "salt",
        "iv",
        "ciphertext",
        "authentication_tag",
        "broker_authentication_tag"
      ]
    },
    "tokenBundle": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "protocol": {
          "$ref": "#/$defs/protocol"
        },
        "access_token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 4096,
          "x-private": true
        },
        "refresh_token": {
          "type": "string",
          "minLength": 1,
          "maxLength": 4096,
          "x-private": true
        },
        "token_type": {
          "const": "Bearer"
        },
        "realm_id": {
          "$ref": "#/$defs/realmId"
        },
        "company_fingerprint": {
          "$ref": "#/$defs/companyFingerprint"
        },
        "token_generation": {
          "$ref": "#/$defs/generation"
        },
        "received_at": {
          "$ref": "#/$defs/timestamp"
        },
        "access_expires_at": {
          "$ref": "#/$defs/timestamp"
        },
        "refresh_expires_at": {
          "$ref": "#/$defs/timestamp"
        },
        "hard_refresh_expires_at": {
          "anyOf": [
            {
              "$ref": "#/$defs/timestamp"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "protocol",
        "access_token",
        "refresh_token",
        "token_type",
        "realm_id",
        "company_fingerprint",
        "token_generation",
        "received_at",
        "access_expires_at",
        "refresh_expires_at",
        "hard_refresh_expires_at"
      ]
    },
    "receiptClaims": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "protocol": {
          "$ref": "#/$defs/protocol"
        },
        "delivery_id": {
          "$ref": "#/$defs/capability"
        },
        "request_id": {
          "$ref": "#/$defs/capability"
        },
        "install_fingerprint": {
          "$ref": "#/$defs/digest"
        },
        "intent": {
          "$ref": "#/$defs/capability"
        },
        "environment": {
          "$ref": "#/$defs/environment"
        },
        "key_generation": {
          "$ref": "#/$defs/generation"
        },
        "token_generation": {
          "$ref": "#/$defs/generation"
        },
        "envelope_hash": {
          "$ref": "#/$defs/digest"
        },
        "outcome": {
          "const": "committed_readback"
        },
        "committed_at": {
          "$ref": "#/$defs/timestamp"
        }
      },
      "required": [
        "protocol",
        "delivery_id",
        "request_id",
        "install_fingerprint",
        "intent",
        "environment",
        "key_generation",
        "token_generation",
        "envelope_hash",
        "outcome",
        "committed_at"
      ]
    },
    "deliveryReceipt": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "claims": {
          "$ref": "#/$defs/receiptClaims"
        },
        "signature": {
          "$ref": "#/$defs/signature"
        }
      },
      "required": [
        "claims",
        "signature"
      ]
    },
    "revokeAttempted": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "protocol": {
          "$ref": "#/$defs/protocol"
        },
        "request_id": {
          "$ref": "#/$defs/capability"
        },
        "install_fingerprint": {
          "$ref": "#/$defs/digest"
        },
        "intent": {
          "$ref": "#/$defs/capability"
        },
        "token_generation": {
          "$ref": "#/$defs/generation"
        },
        "key_generation": {
          "$ref": "#/$defs/generation"
        },
        "issued_at": {
          "$ref": "#/$defs/timestamp"
        },
        "outcome": {
          "type": "string",
          "enum": [
            "confirmed",
            "rejected",
            "uncertain"
          ]
        },
        "provider_contact": {
          "const": "attempted"
        }
      },
      "required": [
        "protocol",
        "request_id",
        "install_fingerprint",
        "intent",
        "token_generation",
        "key_generation",
        "issued_at",
        "outcome",
        "provider_contact"
      ]
    },
    "revokeNotSent": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "protocol": {
          "$ref": "#/$defs/protocol"
        },
        "request_id": {
          "$ref": "#/$defs/capability"
        },
        "install_fingerprint": {
          "$ref": "#/$defs/digest"
        },
        "intent": {
          "$ref": "#/$defs/capability"
        },
        "token_generation": {
          "$ref": "#/$defs/generation"
        },
        "key_generation": {
          "$ref": "#/$defs/generation"
        },
        "issued_at": {
          "$ref": "#/$defs/timestamp"
        },
        "outcome": {
          "const": "rejected"
        },
        "provider_contact": {
          "const": "not_sent"
        },
        "no_contact_proof": {
          "$ref": "#/$defs/noContactProof"
        }
      },
      "required": [
        "protocol",
        "request_id",
        "install_fingerprint",
        "intent",
        "token_generation",
        "key_generation",
        "issued_at",
        "outcome",
        "provider_contact",
        "no_contact_proof"
      ]
    },
    "revokeResponse": {
      "oneOf": [
        {
          "$ref": "#/$defs/revokeAttempted"
        },
        {
          "$ref": "#/$defs/revokeNotSent"
        }
      ]
    },
    "route": {
      "type": "string",
      "enum": [
        "/v1/quickbooks/installations/issue",
        "/v1/quickbooks/authorizations",
        "/v1/quickbooks/launch",
        "/v1/quickbooks/oauth/callback",
        "/v1/quickbooks/tokens/refresh",
        "/v1/quickbooks/tokens/revoke",
        "/health"
      ]
    },
    "phase": {
      "type": "string",
      "enum": [
        "enrollment",
        "start",
        "launched",
        "exchange_started",
        "delivered",
        "refresh_started",
        "refreshed",
        "revoke_started",
        "revoked",
        "failed",
        "canceled",
        "expired",
        "not_sent",
        "proof_consumed"
      ]
    },
    "outcome": {
      "type": "string",
      "enum": [
        "accepted",
        "delivered",
        "refreshed",
        "revoked",
        "owner_canceled",
        "invalid_request",
        "unauthorized",
        "expired",
        "replayed",
        "binding_mismatch",
        "quota_exceeded",
        "ledger_unavailable",
        "provider_rejected",
        "provider_uncertain",
        "delivery_unconfirmed",
        "receipt_invalid",
        "wrapping_key_unavailable",
        "reauthorization_required",
        "no_provider_contact",
        "local_destroyed_remote_unknown",
        "failed",
        "manual_provider_removal_required"
      ]
    },
    "auditEvent": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "protocol": {
          "$ref": "#/$defs/protocol"
        },
        "event_id_hash": {
          "$ref": "#/$defs/digest"
        },
        "request_id_hash": {
          "anyOf": [
            {
              "$ref": "#/$defs/digest"
            },
            {
              "type": "null"
            }
          ]
        },
        "route": {
          "$ref": "#/$defs/route"
        },
        "install_fingerprint": {
          "anyOf": [
            {
              "$ref": "#/$defs/digest"
            },
            {
              "type": "null"
            }
          ]
        },
        "intent_hash": {
          "anyOf": [
            {
              "$ref": "#/$defs/digest"
            },
            {
              "type": "null"
            }
          ]
        },
        "state_hash": {
          "anyOf": [
            {
              "$ref": "#/$defs/digest"
            },
            {
              "type": "null"
            }
          ]
        },
        "phase": {
          "$ref": "#/$defs/phase"
        },
        "outcome": {
          "$ref": "#/$defs/outcome"
        },
        "http_status_class": {
          "type": "string",
          "enum": [
            "2xx",
            "3xx",
            "4xx",
            "5xx"
          ]
        },
        "build_id": {
          "$ref": "#/$defs/digest"
        },
        "key_generation": {
          "$ref": "#/$defs/generation"
        },
        "created_at": {
          "$ref": "#/$defs/timestamp"
        },
        "expires_at": {
          "$ref": "#/$defs/timestamp"
        },
        "duration_ms": {
          "type": "integer",
          "minimum": 0,
          "maximum": 600000
        },
        "attempt_count": {
          "type": "integer",
          "minimum": 0,
          "maximum": 3
        },
        "retention_ms": {
          "type": "integer",
          "minimum": 1,
          "maximum": 2592000000
        }
      },
      "required": [
        "protocol",
        "event_id_hash",
        "request_id_hash",
        "route",
        "install_fingerprint",
        "intent_hash",
        "state_hash",
        "phase",
        "outcome",
        "http_status_class",
        "build_id",
        "key_generation",
        "created_at",
        "expires_at",
        "duration_ms",
        "attempt_count",
        "retention_ms"
      ]
    },
    "replayRow": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "protocol": {
          "$ref": "#/$defs/protocol"
        },
        "route": {
          "$ref": "#/$defs/route"
        },
        "request_id_hash": {
          "$ref": "#/$defs/digest"
        },
        "state_hash": {
          "anyOf": [
            {
              "$ref": "#/$defs/digest"
            },
            {
              "type": "null"
            }
          ]
        },
        "intent_hash": {
          "anyOf": [
            {
              "$ref": "#/$defs/digest"
            },
            {
              "type": "null"
            }
          ]
        },
        "install_fingerprint": {
          "$ref": "#/$defs/digest"
        },
        "phase": {
          "$ref": "#/$defs/phase"
        },
        "provider_attempts": {
          "type": "integer",
          "minimum": 0,
          "maximum": 1
        },
        "key_generation": {
          "$ref": "#/$defs/generation"
        },
        "created_at": {
          "$ref": "#/$defs/timestamp"
        },
        "expires_at": {
          "$ref": "#/$defs/timestamp"
        }
      },
      "required": [
        "protocol",
        "route",
        "request_id_hash",
        "state_hash",
        "intent_hash",
        "install_fingerprint",
        "phase",
        "provider_attempts",
        "key_generation",
        "created_at",
        "expires_at"
      ]
    },
    "quotaRow": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "protocol": {
          "$ref": "#/$defs/protocol"
        },
        "route": {
          "$ref": "#/$defs/route"
        },
        "subject_kind": {
          "type": "string",
          "enum": [
            "install",
            "network",
            "global"
          ]
        },
        "subject_hash": {
          "$ref": "#/$defs/digest"
        },
        "window_start": {
          "$ref": "#/$defs/timestamp"
        },
        "window_ms": {
          "type": "integer",
          "minimum": 1,
          "maximum": 3600000
        },
        "count": {
          "type": "integer",
          "minimum": 0,
          "maximum": 1000000000
        },
        "expires_at": {
          "$ref": "#/$defs/timestamp"
        },
        "retention_ms": {
          "type": "integer",
          "minimum": 1,
          "maximum": 1200000
        }
      },
      "required": [
        "protocol",
        "route",
        "subject_kind",
        "subject_hash",
        "window_start",
        "window_ms",
        "count",
        "expires_at",
        "retention_ms"
      ]
    },
    "ownerIntent": {
      "description": "Active intents retain encrypted delivery keys. Terminal intents retain only the exact receipt replay material after key destruction.",
      "oneOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "protocol": {
              "$ref": "#/$defs/protocol"
            },
            "intent": {
              "$ref": "#/$defs/capability"
            },
            "request_id": {
              "$ref": "#/$defs/capability"
            },
            "install_fingerprint": {
              "$ref": "#/$defs/digest"
            },
            "callback": {
              "$ref": "#/$defs/callback"
            },
            "environment": {
              "$ref": "#/$defs/environment"
            },
            "key_generation": {
              "$ref": "#/$defs/generation"
            },
            "delivery_public_key": {
              "$ref": "#/$defs/publicKey"
            },
            "delivery_private_key": {
              "$ref": "#/$defs/storedCiphertext"
            },
            "created_at": {
              "$ref": "#/$defs/timestamp"
            },
            "expires_at": {
              "$ref": "#/$defs/timestamp"
            },
            "status": {
              "type": "string",
              "enum": [
                "pending",
                "saved"
              ]
            },
            "delivery_id": {
              "anyOf": [
                {
                  "$ref": "#/$defs/capability"
                },
                {
                  "type": "null"
                }
              ]
            },
            "envelope_hash": {
              "anyOf": [
                {
                  "$ref": "#/$defs/digest"
                },
                {
                  "type": "null"
                }
              ]
            },
            "receipt": {
              "anyOf": [
                {
                  "$ref": "#/$defs/deliveryReceipt"
                },
                {
                  "$ref": "#/$defs/completionReceipt"
                },
                {
                  "type": "null"
                }
              ]
            },
            "delivery_auth_key": {
              "$ref": "#/$defs/storedCiphertext"
            },
            "source_binding": {
              "$ref": "#/$defs/digest"
            },
            "expected_token_generation": {
              "$ref": "#/$defs/generation"
            }
          },
          "required": [
            "protocol",
            "intent",
            "request_id",
            "install_fingerprint",
            "callback",
            "environment",
            "key_generation",
            "delivery_public_key",
            "delivery_private_key",
            "created_at",
            "expires_at",
            "status",
            "delivery_id",
            "envelope_hash",
            "receipt",
            "delivery_auth_key",
            "source_binding",
            "expected_token_generation"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "protocol": {
              "$ref": "#/$defs/protocol"
            },
            "intent": {
              "$ref": "#/$defs/capability"
            },
            "status": {
              "const": "committed"
            },
            "delivery_id": {
              "$ref": "#/$defs/capability"
            },
            "envelope_hash": {
              "$ref": "#/$defs/digest"
            },
            "receipt": {
              "$ref": "#/$defs/deliveryReceipt"
            }
          },
          "required": [
            "protocol",
            "intent",
            "status",
            "delivery_id",
            "envelope_hash",
            "receipt"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "protocol": {
              "$ref": "#/$defs/protocol"
            },
            "intent": {
              "$ref": "#/$defs/capability"
            },
            "status": {
              "type": "string",
              "enum": [
                "canceled",
                "failed",
                "expired"
              ]
            },
            "delivery_id": {
              "anyOf": [
                {
                  "$ref": "#/$defs/capability"
                },
                {
                  "type": "null"
                }
              ]
            },
            "envelope_hash": {
              "anyOf": [
                {
                  "$ref": "#/$defs/digest"
                },
                {
                  "type": "null"
                }
              ]
            },
            "receipt": {
              "anyOf": [
                {
                  "$ref": "#/$defs/deliveryReceipt"
                },
                {
                  "$ref": "#/$defs/completionReceipt"
                },
                {
                  "type": "null"
                }
              ]
            }
          },
          "required": [
            "protocol",
            "intent",
            "status",
            "delivery_id",
            "envelope_hash",
            "receipt"
          ]
        }
      ]
    },
    "ownerConnected": {
      "description": "Only connected or delayed status can permit reads; all other states keep reads disabled.",
      "oneOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "protocol": {
              "$ref": "#/$defs/protocol"
            },
            "environment": {
              "$ref": "#/$defs/environment"
            },
            "install_fingerprint": {
              "$ref": "#/$defs/digest"
            },
            "source_binding": {
              "$ref": "#/$defs/digest"
            },
            "company_fingerprint": {
              "$ref": "#/$defs/companyFingerprint"
            },
            "token_generation": {
              "$ref": "#/$defs/generation"
            },
            "status": {
              "type": "string",
              "enum": [
                "connected",
                "delayed"
              ]
            },
            "access_token": {
              "$ref": "#/$defs/storedCiphertext"
            },
            "refresh_token": {
              "$ref": "#/$defs/storedCiphertext"
            },
            "realm_id": {
              "$ref": "#/$defs/storedCiphertext"
            },
            "access_expires_at": {
              "$ref": "#/$defs/timestamp"
            },
            "refresh_expires_at": {
              "$ref": "#/$defs/timestamp"
            },
            "hard_refresh_expires_at": {
              "anyOf": [
                {
                  "$ref": "#/$defs/timestamp"
                },
                {
                  "type": "null"
                }
              ]
            },
            "last_refresh_at": {
              "anyOf": [
                {
                  "$ref": "#/$defs/timestamp"
                },
                {
                  "type": "null"
                }
              ]
            },
            "last_api_read_at": {
              "anyOf": [
                {
                  "$ref": "#/$defs/timestamp"
                },
                {
                  "type": "null"
                }
              ]
            },
            "reads_enabled": {
              "type": "boolean"
            }
          },
          "required": [
            "protocol",
            "environment",
            "install_fingerprint",
            "source_binding",
            "company_fingerprint",
            "token_generation",
            "status",
            "access_token",
            "refresh_token",
            "realm_id",
            "access_expires_at",
            "refresh_expires_at",
            "hard_refresh_expires_at",
            "last_refresh_at",
            "last_api_read_at",
            "reads_enabled"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "protocol": {
              "$ref": "#/$defs/protocol"
            },
            "environment": {
              "$ref": "#/$defs/environment"
            },
            "install_fingerprint": {
              "$ref": "#/$defs/digest"
            },
            "source_binding": {
              "$ref": "#/$defs/digest"
            },
            "company_fingerprint": {
              "$ref": "#/$defs/companyFingerprint"
            },
            "token_generation": {
              "$ref": "#/$defs/generation"
            },
            "status": {
              "type": "string",
              "enum": [
                "reauthorization_required",
                "disconnecting"
              ]
            },
            "access_token": {
              "$ref": "#/$defs/storedCiphertext"
            },
            "refresh_token": {
              "$ref": "#/$defs/storedCiphertext"
            },
            "realm_id": {
              "$ref": "#/$defs/storedCiphertext"
            },
            "access_expires_at": {
              "$ref": "#/$defs/timestamp"
            },
            "refresh_expires_at": {
              "$ref": "#/$defs/timestamp"
            },
            "hard_refresh_expires_at": {
              "anyOf": [
                {
                  "$ref": "#/$defs/timestamp"
                },
                {
                  "type": "null"
                }
              ]
            },
            "last_refresh_at": {
              "anyOf": [
                {
                  "$ref": "#/$defs/timestamp"
                },
                {
                  "type": "null"
                }
              ]
            },
            "last_api_read_at": {
              "anyOf": [
                {
                  "$ref": "#/$defs/timestamp"
                },
                {
                  "type": "null"
                }
              ]
            },
            "reads_enabled": {
              "const": false
            }
          },
          "required": [
            "protocol",
            "environment",
            "install_fingerprint",
            "source_binding",
            "company_fingerprint",
            "token_generation",
            "status",
            "access_token",
            "refresh_token",
            "realm_id",
            "access_expires_at",
            "refresh_expires_at",
            "hard_refresh_expires_at",
            "last_refresh_at",
            "last_api_read_at",
            "reads_enabled"
          ]
        }
      ]
    },
    "ownerDisconnected": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "protocol": {
          "$ref": "#/$defs/protocol"
        },
        "environment": {
          "$ref": "#/$defs/environment"
        },
        "install_fingerprint": {
          "$ref": "#/$defs/digest"
        },
        "source_binding": {
          "$ref": "#/$defs/digest"
        },
        "company_fingerprint": {
          "$ref": "#/$defs/companyFingerprint"
        },
        "token_generation": {
          "$ref": "#/$defs/generation"
        },
        "status": {
          "type": "string",
          "enum": [
            "disconnected",
            "local_destroyed_remote_unknown"
          ]
        },
        "reads_enabled": {
          "const": false
        },
        "receipt_hash": {
          "$ref": "#/$defs/digest"
        }
      },
      "required": [
        "protocol",
        "environment",
        "install_fingerprint",
        "source_binding",
        "company_fingerprint",
        "token_generation",
        "status",
        "reads_enabled",
        "receipt_hash"
      ]
    },
    "ownerConnection": {
      "oneOf": [
        {
          "$ref": "#/$defs/ownerConnected"
        },
        {
          "$ref": "#/$defs/ownerDisconnected"
        }
      ]
    },
    "ownerFence": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "protocol": {
          "$ref": "#/$defs/protocol"
        },
        "operation": {
          "type": "string",
          "enum": [
            "refresh",
            "revoke"
          ]
        },
        "request_id": {
          "$ref": "#/$defs/capability"
        },
        "intent": {
          "$ref": "#/$defs/capability"
        },
        "install_fingerprint": {
          "$ref": "#/$defs/digest"
        },
        "token_generation": {
          "$ref": "#/$defs/generation"
        },
        "status": {
          "const": "outcome_unknown"
        },
        "lease_id": {
          "$ref": "#/$defs/capability"
        },
        "lease_expires_at": {
          "$ref": "#/$defs/timestamp"
        },
        "created_at": {
          "$ref": "#/$defs/timestamp"
        },
        "provider_contact": {
          "type": "string",
          "enum": [
            "unknown",
            "not_sent",
            "attempted"
          ]
        }
      },
      "required": [
        "protocol",
        "operation",
        "request_id",
        "intent",
        "install_fingerprint",
        "token_generation",
        "status",
        "lease_id",
        "lease_expires_at",
        "created_at",
        "provider_contact"
      ]
    },
    "ownerStatus": {
      "description": "Only connected or delayed status can permit reads; all other states keep reads disabled.",
      "oneOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "protocol": {
              "$ref": "#/$defs/protocol"
            },
            "status": {
              "type": "string",
              "enum": [
                "connected",
                "delayed"
              ]
            },
            "reads_enabled": {
              "type": "boolean"
            },
            "last_refresh_at": {
              "anyOf": [
                {
                  "$ref": "#/$defs/timestamp"
                },
                {
                  "type": "null"
                }
              ]
            },
            "last_api_read_at": {
              "anyOf": [
                {
                  "$ref": "#/$defs/timestamp"
                },
                {
                  "type": "null"
                }
              ]
            },
            "outcome": {
              "anyOf": [
                {
                  "$ref": "#/$defs/outcome"
                },
                {
                  "type": "null"
                }
              ]
            }
          },
          "required": [
            "protocol",
            "status",
            "reads_enabled",
            "last_refresh_at",
            "last_api_read_at",
            "outcome"
          ]
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "protocol": {
              "$ref": "#/$defs/protocol"
            },
            "status": {
              "type": "string",
              "enum": [
                "not_connected",
                "connecting",
                "reauthorization_required",
                "disconnecting",
                "disconnected",
                "local_destroyed_remote_unknown"
              ]
            },
            "reads_enabled": {
              "const": false
            },
            "last_refresh_at": {
              "anyOf": [
                {
                  "$ref": "#/$defs/timestamp"
                },
                {
                  "type": "null"
                }
              ]
            },
            "last_api_read_at": {
              "anyOf": [
                {
                  "$ref": "#/$defs/timestamp"
                },
                {
                  "type": "null"
                }
              ]
            },
            "outcome": {
              "anyOf": [
                {
                  "$ref": "#/$defs/outcome"
                },
                {
                  "type": "null"
                }
              ]
            }
          },
          "required": [
            "protocol",
            "status",
            "reads_enabled",
            "last_refresh_at",
            "last_api_read_at",
            "outcome"
          ]
        }
      ]
    },
    "healthResponse": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "protocol": {
          "$ref": "#/$defs/protocol"
        },
        "build_id": {
          "$ref": "#/$defs/digest"
        },
        "key_generation": {
          "$ref": "#/$defs/generation"
        },
        "ready": {
          "type": "boolean"
        },
        "dependencies": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "replay_ledger": {
              "type": "string",
              "enum": [
                "ready",
                "unavailable"
              ]
            },
            "configuration": {
              "type": "string",
              "enum": [
                "ready",
                "unavailable"
              ]
            }
          },
          "required": [
            "replay_ledger",
            "configuration"
          ]
        }
      },
      "required": [
        "protocol",
        "build_id",
        "key_generation",
        "ready",
        "dependencies"
      ]
    },
    "errorResponse": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "protocol": {
          "$ref": "#/$defs/protocol"
        },
        "code": {
          "$ref": "#/$defs/outcome"
        },
        "retry": {
          "type": "string",
          "enum": [
            "never",
            "fresh_consent",
            "after_delay",
            "no_contact_proof",
            "manual_provider_removal"
          ]
        }
      },
      "required": [
        "protocol",
        "code",
        "retry"
      ]
    },
    "realmId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128,
      "pattern": "^[A-Za-z0-9._~-]{1,128}$",
      "x-private": true
    },
    "companyFingerprint": {
      "type": "string",
      "minLength": 64,
      "maxLength": 64,
      "pattern": "^[a-f0-9]{64}$"
    },
    "transactionPayload": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "protocol": {
          "$ref": "#/$defs/protocol"
        },
        "voucher": {
          "$ref": "#/$defs/installationVoucher"
        },
        "install_fingerprint": {
          "$ref": "#/$defs/digest"
        },
        "intent": {
          "$ref": "#/$defs/capability"
        },
        "request_id": {
          "$ref": "#/$defs/capability"
        },
        "callback": {
          "$ref": "#/$defs/callback"
        },
        "environment": {
          "$ref": "#/$defs/environment"
        },
        "delivery_public_key": {
          "$ref": "#/$defs/publicKey"
        },
        "delivery_key_fingerprint": {
          "$ref": "#/$defs/digest"
        },
        "state": {
          "$ref": "#/$defs/capability",
          "x-private": true
        },
        "launch_capability_hash": {
          "$ref": "#/$defs/digest"
        },
        "start_hash": {
          "$ref": "#/$defs/digest"
        },
        "issued_at": {
          "$ref": "#/$defs/timestamp"
        },
        "expires_at": {
          "$ref": "#/$defs/timestamp"
        },
        "key_generation": {
          "$ref": "#/$defs/generation"
        },
        "provider_configuration_hash": {
          "$ref": "#/$defs/digest"
        },
        "delivery_auth_key": {
          "$ref": "#/$defs/digest",
          "x-private": true
        },
        "expected_token_generation": {
          "$ref": "#/$defs/generation"
        }
      },
      "required": [
        "protocol",
        "voucher",
        "install_fingerprint",
        "intent",
        "request_id",
        "callback",
        "environment",
        "delivery_public_key",
        "delivery_key_fingerprint",
        "state",
        "launch_capability_hash",
        "start_hash",
        "issued_at",
        "expires_at",
        "key_generation",
        "provider_configuration_hash",
        "delivery_auth_key",
        "expected_token_generation"
      ],
      "description": "Transient sealed browser context only. It must never enter the broker replay or audit store. Contains a one-time delivery authentication key, but no provider authorization code or token."
    },
    "transactionCapsule": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "key_generation": {
          "$ref": "#/$defs/generation"
        },
        "iv": {
          "type": "string",
          "minLength": 16,
          "maxLength": 16,
          "pattern": "^[A-Za-z0-9_-]{16}$"
        },
        "ciphertext": {
          "type": "string",
          "minLength": 22,
          "maxLength": 3500,
          "pattern": "^[A-Za-z0-9_-]+$",
          "x-private": true
        },
        "authentication_tag": {
          "type": "string",
          "minLength": 22,
          "maxLength": 22,
          "pattern": "^[A-Za-z0-9_-]{22}$"
        }
      },
      "required": [
        "key_generation",
        "iv",
        "ciphertext",
        "authentication_tag"
      ],
      "description": "AES-256-GCM under the launch context key. The complete compact cookie including name and attributes must stay below 4096 bytes; implementations enforce serialized byte limits."
    },
    "transactionCookie": {
      "$ref": "#/$defs/transactionCapsule",
      "description": "Same sealed shape as the launch capsule, re-encrypted with a fresh IV under the distinct cookie key. Never interchange keys or contexts."
    },
    "completionOutcome": {
      "type": "string",
      "enum": [
        "owner_canceled",
        "failed",
        "manual_provider_removal_required"
      ]
    },
    "completionHeader": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "protocol": {
          "$ref": "#/$defs/protocol"
        },
        "purpose": {
          "const": "completion"
        },
        "delivery_id": {
          "$ref": "#/$defs/capability"
        },
        "request_id": {
          "$ref": "#/$defs/capability"
        },
        "install_fingerprint": {
          "$ref": "#/$defs/digest"
        },
        "intent": {
          "$ref": "#/$defs/capability"
        },
        "callback": {
          "$ref": "#/$defs/callback"
        },
        "environment": {
          "$ref": "#/$defs/environment"
        },
        "key_generation": {
          "$ref": "#/$defs/generation"
        },
        "delivery_key_fingerprint": {
          "$ref": "#/$defs/digest"
        },
        "token_generation": {
          "$ref": "#/$defs/generation"
        },
        "expires_at": {
          "$ref": "#/$defs/timestamp"
        }
      },
      "required": [
        "protocol",
        "purpose",
        "delivery_id",
        "request_id",
        "install_fingerprint",
        "intent",
        "callback",
        "environment",
        "key_generation",
        "delivery_key_fingerprint",
        "token_generation",
        "expires_at"
      ]
    },
    "completionEnvelope": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "header": {
          "$ref": "#/$defs/completionHeader"
        },
        "ephemeral_public_key": {
          "$ref": "#/$defs/publicKey"
        },
        "salt": {
          "$ref": "#/$defs/digest"
        },
        "iv": {
          "type": "string",
          "minLength": 16,
          "maxLength": 16,
          "pattern": "^[A-Za-z0-9_-]{16}$"
        },
        "ciphertext": {
          "type": "string",
          "minLength": 22,
          "maxLength": 40000,
          "pattern": "^[A-Za-z0-9_-]+$",
          "x-private": true
        },
        "authentication_tag": {
          "type": "string",
          "minLength": 22,
          "maxLength": 22,
          "pattern": "^[A-Za-z0-9_-]{22}$"
        },
        "broker_authentication_tag": {
          "$ref": "#/$defs/digest"
        }
      },
      "required": [
        "header",
        "ephemeral_public_key",
        "salt",
        "iv",
        "ciphertext",
        "authentication_tag",
        "broker_authentication_tag"
      ],
      "description": "Authenticated encrypted status-only delivery to a verified owner intent. Uses the same ECDH, AEAD, and one-time sender authentication as token delivery, with a distinct completion purpose."
    },
    "completionResult": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "protocol": {
          "$ref": "#/$defs/protocol"
        },
        "outcome": {
          "$ref": "#/$defs/completionOutcome"
        }
      },
      "required": [
        "protocol",
        "outcome"
      ]
    },
    "completionReceiptClaims": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "protocol": {
          "$ref": "#/$defs/protocol"
        },
        "delivery_id": {
          "$ref": "#/$defs/capability"
        },
        "request_id": {
          "$ref": "#/$defs/capability"
        },
        "install_fingerprint": {
          "$ref": "#/$defs/digest"
        },
        "intent": {
          "$ref": "#/$defs/capability"
        },
        "environment": {
          "$ref": "#/$defs/environment"
        },
        "key_generation": {
          "$ref": "#/$defs/generation"
        },
        "token_generation": {
          "$ref": "#/$defs/generation"
        },
        "envelope_hash": {
          "$ref": "#/$defs/digest"
        },
        "outcome": {
          "$ref": "#/$defs/completionOutcome"
        },
        "committed_at": {
          "$ref": "#/$defs/timestamp"
        }
      },
      "required": [
        "protocol",
        "delivery_id",
        "request_id",
        "install_fingerprint",
        "intent",
        "environment",
        "key_generation",
        "token_generation",
        "envelope_hash",
        "outcome",
        "committed_at"
      ]
    },
    "completionReceipt": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "claims": {
          "$ref": "#/$defs/completionReceiptClaims"
        },
        "signature": {
          "$ref": "#/$defs/signature"
        }
      },
      "required": [
        "claims",
        "signature"
      ]
    },
    "ownerCallbackRequest": {
      "oneOf": [
        {
          "$ref": "#/$defs/deliveryEnvelope"
        },
        {
          "$ref": "#/$defs/completionEnvelope"
        }
      ]
    },
    "ownerCallbackReceipt": {
      "oneOf": [
        {
          "$ref": "#/$defs/deliveryReceipt"
        },
        {
          "$ref": "#/$defs/completionReceipt"
        }
      ]
    }
  }
};
