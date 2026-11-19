import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";

export function TeamCard({ members }: { members: Member[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Team</CardTitle>
        <CardDescription>Invite people to work with you.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {members.map((m) => (
          <Avatar key={m.id}>
            <AvatarImage src={m.avatar} alt={m.name} />
            <AvatarFallback>{m.initials}</AvatarFallback>
          </Avatar>
        ))}
      </CardContent>
      <CardFooter>
        <Button variant="outline">Invite</Button>
      </CardFooter>
    </Card>
  );
}
