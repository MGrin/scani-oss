# GitHub Copilot Agent Configurations

This directory contains specialized agent configurations for GitHub Copilot. Each agent is optimized for specific tasks within the Scani codebase.

## Available Agents

### General Coding Agent (Default)

**Location**: `../.github/copilot-instructions.md`
**Expertise**: General TypeScript, React, tRPC development
**Use Cases**: 
- Bug fixes
- Feature implementation
- Code refactoring
- General development tasks

**How to Use**: GitHub Copilot automatically uses these instructions for all coding tasks in this repository.

## Agent Configuration Guidelines

### Creating New Agent Configurations

If you need specialized agents for specific tasks, create configuration files in this directory:

```
.github/agents/
├── README.md (this file)
├── backend-specialist.md (example: backend-focused agent)
├── frontend-specialist.md (example: frontend-focused agent)
└── database-specialist.md (example: database migration agent)
```

### Agent Configuration Structure

Each agent configuration should follow this structure:

```markdown
# Agent Name

## Expertise
What this agent specializes in

## Scope
Which parts of the codebase this agent works with

## Instructions
Specific instructions and patterns for this agent

## Examples
Example tasks and solutions
```

## Best Practices

### When to Create Specialized Agents

Create specialized agents for:
- Complex domain-specific operations (e.g., financial calculations)
- Repetitive patterns that need consistency (e.g., API endpoint creation)
- Security-sensitive operations (e.g., authentication changes)
- Multi-step workflows (e.g., database migrations + code updates)

### Agent Interaction Patterns

**Delegation**: The main Copilot agent can delegate to specialized agents when:
- A task matches the specialized agent's expertise
- The task requires domain-specific knowledge
- Consistency with existing patterns is critical

**Collaboration**: Multiple agents can work together by:
- Sharing context through commit messages
- Following the same architectural patterns
- Using common validation steps (lint, test, build)

## Current Architecture Support

### Clean Architecture Layers

Agents should respect the clean architecture structure:

```
presentation/ (routers)
    ↓ uses
application/ (use-cases, services)
    ↓ uses  
infrastructure/ (repositories, database)
```

**Guidelines**:
- Routers should be thin controllers delegating to use cases
- Use cases contain business logic and orchestrate services
- Services handle external integrations (APIs, pricing)
- Repositories abstract database operations

### Type Safety Requirements

All agents must maintain:
- End-to-end type safety via tRPC
- Zod schema validation for all inputs
- TypeScript strict mode compliance
- Shared types from `@scani/backend/router`

## Testing Standards

All agent changes must:
- Maintain 93%+ test coverage
- Pass `bun test` without failures
- Include tests for new functionality
- Update tests for modified behavior

## Security Standards

All agents must:
- Never bypass `protectedProcedure` for user data
- Use `getUserId(ctx)` for user scoping
- Validate all inputs with Zod schemas
- Use `Decimal.js` for financial calculations
- Never commit secrets or credentials
- Check dependencies for vulnerabilities

## Integration with Main Instructions

Specialized agents should:
1. Read the main `copilot-instructions.md` first
2. Apply their specialized knowledge on top
3. Follow all general patterns and anti-patterns
4. Respect the security considerations
5. Use the same development workflows

## Future Agent Ideas

Potential specialized agents to consider:

- **Financial Calculator Agent**: Specialized in monetary calculations and Decimal.js usage
- **Authentication Agent**: Expert in Supabase auth and user management
- **Database Migration Agent**: Handles schema changes and migrations safely
- **API Integration Agent**: Manages external API integrations (Finnhub, CoinGecko)
- **Test Generator Agent**: Creates comprehensive test suites
- **Documentation Agent**: Maintains and updates project documentation

## Support

For questions about agent configurations:
1. Review the main `copilot-instructions.md`
2. Check existing patterns in the codebase
3. Consult the architecture documentation in `/docs/ARCHITECTURE.md`
4. Follow the security and testing standards above
