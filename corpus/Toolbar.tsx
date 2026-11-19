import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export function Toolbar({ count }: { count: number }) {
  return (
    <div className="flex items-center gap-2">
      <Button variant="outline" size="sm">Filter</Button>
      <Button variant="outline" size="sm">Sort</Button>
      <Badge variant="secondary">{count}</Badge>
      <Button size="sm">Export</Button>
    </div>
  );
}
