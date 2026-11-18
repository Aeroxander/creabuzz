import { MessageSquare } from "lucide-react";
import { BackHeader } from "../../app/BackHeader";
import { useAccount } from "../../lib/account";
import { useFollowPerson, useFollows } from "../../lib/follows";
import { nameOf, pictureOf, useProfiles } from "../../lib/profiles";
import { useRequireAccount } from "../../lib/use-require-account";
import { Avatar } from "../../ui/avatar";
import { Button, ButtonLink } from "../../ui/button";
import { Card } from "../../ui/card";
import { useToast } from "../../ui/toast";
import { ProjectCard } from "../home/ProjectCard";
import { PostCard } from "../posts/PostCard";
import { engagementOf, useEngagement, usePostsBy } from "../posts/use-posts";
import { useProjectsBy } from "./use-own-projects";

/** The head of a profile: picture, name, about. The name is the screen's h1 unless the screen has its own. */
export function ProfileHead({
  pubkey,
  level = "h1",
}: {
  pubkey: string;
  level?: "h1" | "h2";
}) {
  const Heading = level;
  const profiles = useProfiles([pubkey]).data;
  const name = nameOf(profiles, pubkey);
  const about = profiles?.[pubkey]?.about?.trim();
  return (
    <div className="flex items-center gap-4" data-testid="profile-head">
      <Avatar
        name={name}
        picture={pictureOf(profiles, pubkey)}
        pubkey={pubkey}
        size="lg"
      />
      <div className="min-w-0">
        <Heading className="headline truncate text-2xl">{name}</Heading>
        {about ? (
          <p className="mt-1 line-clamp-3 text-sm text-muted">{about}</p>
        ) : null}
      </div>
    </div>
  );
}

/** Someone's profile: who they are, their projects and their posts; follow them or send a message. */
export function ProfilePage({ pubkey }: { pubkey: string }) {
  const { pubkey: me } = useAccount();
  const projects = useProjectsBy(pubkey).data ?? [];
  const posts = usePostsBy(pubkey).data ?? [];
  const profiles = useProfiles([pubkey]).data;
  const engagement = useEngagement(posts.map((p) => p.id)).data;
  const follows = useFollows().data;
  const follow = useFollowPerson();
  const requireAccount = useRequireAccount();
  const toast = useToast();
  const following = follows?.people.has(pubkey) ?? false;
  const self = me === pubkey;
  return (
    <main
      className="screen mx-auto flex max-w-lg flex-col gap-5"
      data-testid="profile-page"
    >
      <BackHeader heading={false} title="Profile" />
      <ProfileHead pubkey={pubkey} />
      {self ? null : (
        <div className="flex gap-2">
          <Button
            aria-pressed={following}
            className="flex-1"
            data-testid="profile-follow"
            disabled={follow.isPending}
            onClick={() =>
              requireAccount(() =>
                follow.mutate(
                  { pubkey, follow: !following },
                  { onError: (error) => toast(error.message, "problem") },
                ),
              )
            }
            variant={following ? "secondary" : "primary"}
          >
            {following ? "Following" : "Follow"}
          </Button>
          <ButtonLink
            data-testid="profile-message"
            params={{ peer: pubkey }}
            to="/you/messages/$peer"
            variant="secondary"
          >
            <MessageSquare aria-hidden="true" size={18} />
            Message
          </ButtonLink>
        </div>
      )}
      {projects.length > 0 ? (
        <section
          aria-labelledby="profile-projects"
          className="flex flex-col gap-3"
        >
          <h2
            id="profile-projects"
            className="text-sm font-semibold uppercase tracking-wider text-muted"
          >
            Projects
          </h2>
          {projects.map((project) => (
            <ProjectCard
              key={project.coordinate}
              profiles={profiles}
              project={project}
            />
          ))}
        </section>
      ) : null}
      <section aria-labelledby="profile-posts" className="flex flex-col gap-3">
        <h2
          id="profile-posts"
          className="text-sm font-semibold uppercase tracking-wider text-muted"
        >
          Posts
        </h2>
        {posts.length === 0 ? (
          <Card tone="plain">
            <p className="text-sm text-muted">No posts yet.</p>
          </Card>
        ) : (
          posts.map((event) => (
            <PostCard
              engagement={engagementOf(engagement, event.id)}
              event={event}
              key={event.id}
              profiles={profiles}
            />
          ))
        )}
      </section>
    </main>
  );
}
