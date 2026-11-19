import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export function PricingCard({ plan }: { plan: Plan }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{plan.name}</CardTitle>
        <CardDescription>{plan.blurb}</CardDescription>
        <Badge variant="secondary">Popular</Badge>
      </CardHeader>
      <CardContent>
        <p className="text-3xl font-bold">{plan.price}</p>
      </CardContent>
      <CardFooter>
        <Button className="w-full">Subscribe</Button>
      </CardFooter>
    </Card>
  );
}
