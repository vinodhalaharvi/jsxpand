import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

export function ActivityCard({ items }: { items: Item[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent activity</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        {items.map((it) => (
          <div key={it.id} className="flex items-center gap-4">
            <Avatar>
              <AvatarFallback>{it.initials}</AvatarFallback>
            </Avatar>
            <Badge variant="outline">{it.kind}</Badge>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
