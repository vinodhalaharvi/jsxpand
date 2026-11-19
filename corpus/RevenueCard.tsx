import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";

export function RevenueCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Revenue</CardTitle>
        <CardDescription>Last 30 days</CardDescription>
      </CardHeader>
      <CardContent>
        <RevenueChart />
      </CardContent>
    </Card>
  );
}
