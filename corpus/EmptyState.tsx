import { Card, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export function EmptyState() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>No projects yet</CardTitle>
        <CardDescription>Create your first project to get started.</CardDescription>
      </CardHeader>
      <CardFooter>
        <Button>New project</Button>
      </CardFooter>
    </Card>
  );
}
