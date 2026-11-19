import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

export function ReportTabs() {
  return (
    <Tabs defaultValue="overview">
      <TabsList>
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="analytics">Analytics</TabsTrigger>
        <TabsTrigger value="reports">Reports</TabsTrigger>
      </TabsList>
      <TabsContent value="overview">
        <Overview />
      </TabsContent>
      <TabsContent value="analytics">
        <Analytics />
      </TabsContent>
      <TabsContent value="reports">
        <Reports />
      </TabsContent>
    </Tabs>
  );
}
