/**
 * A pull request merged into a branch, as a forge adapter hands it to core.
 *
 * The adapter owns the platform's payload and translates it to this; nothing
 * that consumes the signal reads webhook fields. A repository is named the way
 * a project's `repository_url` names it, so a consumer can match the two.
 */
export interface BranchMerged {
  repo: { owner: string; name: string };
  /** The branch the pull request merged into. */
  branch: string;
  /** The commit the merge left at the tip of `branch`. */
  sha: string;
  pr: number;
}
