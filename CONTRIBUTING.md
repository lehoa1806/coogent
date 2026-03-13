# Contributing to Coogent

Thank you for your interest in contributing to Coogent!

## Getting Started

For full development setup, project structure, debugging, testing, and build instructions, see:

**[Developer & Contributor Guide →](docs/developer-guide.md)**

## Quick Reference

| Task | Command |
|---|---|
| Build everything | `npm run build` |
| Watch mode | `npm run watch` |
| Run tests | `npm test` |
| Lint + type-check | `npm run lint` |
| Full CI | `npm run ci` |

## Contribution Process

1. Fork and clone the repository
2. Create a feature branch from `main`
3. Follow the code conventions in the [Developer Guide](docs/developer-guide.md#code-style--conventions)
4. Add tests for new functionality
5. Run `npm run ci` and ensure all checks pass
6. Submit a pull request with a clear description of changes

## Commit Conventions

- Use present-tense imperative mood: "Add feature" not "Added feature"
- Prefix with category when helpful: `fix:`, `feat:`, `refactor:`, `docs:`, `test:`, `chore:`
- Reference issues where applicable

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
