# Remove Beads Integration — Design

**Date:** 2026-09-01

## Goal

Remove the Beads (`bd`) integration from the published Pi extension package and from both installed package caches, without changing the remaining extensions.

## Approach

Delete `extensions/beads.ts`, remove its package description and README entry, and verify that no Beads-specific references remain in the repository. Run the existing package tests to guard the remaining extensions. Commit and push the source cleanup to `master`, then update the global and project package installations so their managed clones reconcile to the pushed commit.

## Boundaries

- Do not alter project data outside the Pi extension package caches.
- Do not delete unrelated `.beads` directories in arbitrary repositories.
- Keep Ralph, background jobs, browser flows, and MiMo memory unchanged.
- Do not add the Pi example subagent extension as part of this cleanup.

## Verification

- Repository search returns no Beads or `bd` integration references.
- `npm test` passes.
- GitHub `master` contains the cleanup commit.
- `pi update --extensions` reconciles installed package clones.
- Installed extension directories no longer contain `beads.ts`.
