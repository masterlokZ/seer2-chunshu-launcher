      [Embed(source="../uclient-ftr-battle-template/placeholder-0.png")] private static const Atlas0:Class;
      [Embed(source="../uclient-ftr-battle-template/placeholder-1.png")] private static const Atlas1:Class;
      [Embed(source="../uclient-ftr-battle-template/placeholder-2.png")] private static const Atlas2:Class;
      [Embed(source="../uclient-ftr-battle-template/placeholder-3.png")] private static const Atlas3:Class;
      [Embed(source="../uclient-ftr-battle-template/placeholder-4.png")] private static const Atlas4:Class;
      [Embed(source="../uclient-ftr-battle-template/placeholder-5.png")] private static const Atlas5:Class;
      [Embed(source="../uclient-ftr-battle-template/placeholder-6.png")] private static const Atlas6:Class;
      [Embed(source="../uclient-ftr-battle-template/placeholder-7.png")] private static const Atlas7:Class;

      private static function createAtlasFactories(count:int):Array
      {
         return [Atlas0,Atlas1,Atlas2,Atlas3,Atlas4,Atlas5,Atlas6,Atlas7]
            .slice(0,Math.max(0,Math.min(8,count)));
      }
