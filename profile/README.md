# AntelopeJS

Open-source TypeScript tools for Node.js backends. Plug a PostgreSQL, MongoDB or RethinkDB database into AntelopeJS DMS and get a back office and an analytics dashboard as TypeScript in your repository.

![Screen recording of the AntelopeJS DMS Builder. The Connect form is filled from a postgres:// URL under the caption Paste the URL. Press Connect. Four steps run, the Builder reports 11 tables detected, then a Music Overview dashboard with four count cards appears under the caption First pass done in 10:50.](./media/hero-connect.gif)

[DMS docs](https://dms.antelopejs.com/docs) · [Framework docs](https://framework.antelopejs.com/docs) · [Interfaces](https://interfaces.antelopejs.com) · [Modules](https://interfaces.antelopejs.com/modules) · [Roadmap](https://github.com/orgs/AntelopeJS/projects) · [Discord](https://discord.gg/sjK28QHrA7)

Follow us: [LinkedIn](https://www.linkedin.com/company/antelope-js) · [X](https://x.com/Antelopejs) · [Facebook](https://www.facebook.com/people/Antelopejs/100095449986721/)

---

## Products

- **[AntelopeJS DMS](https://github.com/AntelopeJS/dms)** (Open source, Preview). Connect your PostgreSQL, MongoDB or RethinkDB database and your coding agent writes the back office and an analytics dashboard as typed TypeScript. Generated pages are read-only by default. The connection can write whatever its database account can, so connect with an account that can only read. [Docs](https://dms.antelopejs.com/docs)
- **[AntelopeJS Cloud](https://cloud.antelopejs.com)** (Waitlist). Managed hosting for AntelopeJS applications, and the only paid part of AntelopeJS. [Join the waitlist](https://cloud.antelopejs.com)
- **[AntelopeJS framework](https://github.com/AntelopeJS/antelopejs)** (Open source). The TypeScript runtime and `ajs` CLI. Business modules depend on contracts, provider modules implement them, and the application chooses which one to load. [Docs](https://framework.antelopejs.com/docs)

Statuses: Open source means the code is public under Apache-2.0. Preview means the version is below 1.0 and its interfaces can still change. Waitlist means you can sign up but cannot use it yet.

## Repositories

### Core

| Repository                                                       | Description                                                             |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [antelopejs](https://github.com/AntelopeJS/antelopejs)           | Runtime, module lifecycle and the `ajs` CLI (`@antelopejs/core`)        |
| [interface-core](https://github.com/AntelopeJS/interface-core)   | Interface primitives: proxies, decorators, interface functions, logging |
| [tooling-configs](https://github.com/AntelopeJS/tooling-configs) | Shared oxlint and Knip presets for AntelopeJS projects                  |

### Interfaces

The contracts. Full docs on [interfaces.antelopejs.com](https://interfaces.antelopejs.com).

| Repository                                                                                   | Contract                                             |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| [interface-api](https://github.com/AntelopeJS/interface-api)                                 | Decorator-based HTTP controllers                     |
| [interface-api-util](https://github.com/AntelopeJS/interface-api-util)                       | Request validation, rate limiting, HTTP errors       |
| [interface-auth](https://github.com/AntelopeJS/interface-auth)                               | Authentication and authorization                     |
| [interface-data-api](https://github.com/AntelopeJS/interface-data-api)                       | CRUD controllers with pagination, sorting, filtering |
| [interface-database](https://github.com/AntelopeJS/interface-database)                       | Database-agnostic queries (AQL)                      |
| [interface-database-decorators](https://github.com/AntelopeJS/interface-database-decorators) | Table and model definitions with decorators          |
| [interface-email](https://github.com/AntelopeJS/interface-email)                             | Email sending: templates, batch, attachments         |
| [interface-file-storage](https://github.com/AntelopeJS/interface-file-storage)               | File storage with presigned URLs and metadata        |
| [interface-mongodb](https://github.com/AntelopeJS/interface-mongodb)                         | Direct MongoDB client access                         |
| [interface-redis](https://github.com/AntelopeJS/interface-redis)                             | Redis operations                                     |
| [interface-redis-scheduler](https://github.com/AntelopeJS/interface-redis-scheduler)         | Distributed task scheduling on Redis                 |
| [interface-rethinkdb](https://github.com/AntelopeJS/interface-rethinkdb)                     | Direct RethinkDB access                              |
| [interface-stripe](https://github.com/AntelopeJS/interface-stripe)                           | Payments and webhooks                                |

### Providers

Implementations you can swap.

| Repository                                                             | Provides                                         |
| ---------------------------------------------------------------------- | ------------------------------------------------ |
| [api](https://github.com/AntelopeJS/api)                               | HTTP and WebSocket server                        |
| [auth-jwt](https://github.com/AntelopeJS/auth-jwt)                     | JWT authentication                               |
| [mongodb](https://github.com/AntelopeJS/mongodb)                       | MongoDB, also implements the Database contract   |
| [rethinkdb](https://github.com/AntelopeJS/rethinkdb)                   | RethinkDB, also implements the Database contract |
| [redis](https://github.com/AntelopeJS/redis)                           | Redis and Redis Scheduler                        |
| [stripe](https://github.com/AntelopeJS/stripe)                         | Stripe payments                                  |
| [nodemailer](https://github.com/AntelopeJS/nodemailer)                 | Email through Nodemailer                         |
| [file-storage-s3](https://github.com/AntelopeJS/file-storage-s3)       | File storage on S3                               |
| [file-storage-local](https://github.com/AntelopeJS/file-storage-local) | File storage on the local disk                   |

### DMS

Dashboard core and modules.

| Repository                                                     | Description                                      |
| -------------------------------------------------------------- | ------------------------------------------------ |
| [dms](https://github.com/AntelopeJS/dms)                       | Runtime module and public interface package      |
| [dms-frontend](https://github.com/AntelopeJS/dms-frontend)     | Frontend loader and `ajs dms` CLI plugin (Vue 3) |
| [dms-ai](https://github.com/AntelopeJS/dms-ai)                 | AI assistant that knows DMS conventions          |
| [dms-builder](https://github.com/AntelopeJS/dms-builder)       | Visual page builder                              |
| [dms-database](https://github.com/AntelopeJS/dms-database)     | Row explorer, schema diagram, AQL playground     |
| [dms-api](https://github.com/AntelopeJS/dms-api)               | Endpoint tree, docs and request statistics       |
| [dms-saas](https://github.com/AntelopeJS/dms-saas)             | Tenants, plans, subscriptions and invoicing      |
| [dms-lang](https://github.com/AntelopeJS/dms-lang)             | Locales and translation keys                     |
| [dms-media](https://github.com/AntelopeJS/dms-media)           | Media library                                    |
| [dms-automation](https://github.com/AntelopeJS/dms-automation) | Workflow automation                              |
| [dms-mailing](https://github.com/AntelopeJS/dms-mailing)       | Mail templates, sends and delivery tracking      |
| [dms-marketing](https://github.com/AntelopeJS/dms-marketing)   | Pages, campaigns, funnels and analytics          |

### Templates

| Repository                                                                             | Use it to                                |
| -------------------------------------------------------------------------------------- | ---------------------------------------- |
| [template-dms-demo](https://github.com/AntelopeJS/template-dms-demo)                   | Run a complete DMS with seeded demo data |
| [template-dms-adonis](https://github.com/AntelopeJS/template-dms-adonis)               | Use DMS with an AdonisJS backend         |
| [template-module-typescript](https://github.com/AntelopeJS/template-module-typescript) | Create an interface or implement one     |
| [template-blank-typescript](https://github.com/AntelopeJS/template-blank-typescript)   | Start an empty module                    |
| [template-todo-typescript](https://github.com/AntelopeJS/template-todo-typescript)     | Read a small working example             |

## Get involved

- **Questions and feedback**: [Discord](https://discord.gg/sjK28QHrA7)
- **Bugs**: open an issue in the relevant repository
- **What's next**: [public roadmap](https://github.com/orgs/AntelopeJS/projects)
- **News and releases**: [LinkedIn](https://www.linkedin.com/company/antelope-js) · [X](https://x.com/Antelopejs) · [Facebook](https://www.facebook.com/people/Antelopejs/100095449986721/)
- **Contributing**: read the [contribution guidelines](../CONTRIBUTING.md) before opening a pull request
- **Security**: report vulnerabilities privately through our [security policy](../SECURITY.md)

---

AntelopeJS is built and maintained by [Antelope SRL](https://antelopejs.com), Belgium. The framework and the DMS are released under the Apache License 2.0. Check each repository for its definitive license. AntelopeJS Cloud is our managed, paid offering.
